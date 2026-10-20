#!/usr/bin/env bash
# Connects a GitHub repository to the KDLA web app on Azure, so that every push to the main branch is
# tested and, when the tests pass, deployed automatically by GitHub Actions (.github/workflows/azure-webapp.yml).
#
# Run it once in Azure Cloud Shell (Bash), from the project folder:
#   bash infra/github-setup.sh <github-account>/<repository>      for example: perceive1990/kdla-cms
#
# What it does:
#   1. If the web app does not exist yet, creates the Azure resources first with infra/provision.sh.
#   2. Signs you in to GitHub: you confirm a one-time code at https://github.com/login/device.
#   3. Creates a managed identity that only this repository's main branch can use (OpenID Connect, so no
#      password or key is stored in GitHub) and allows it to deploy to this one web app and nothing else.
#   4. Saves the identity details and the web app name as the repository's Actions secrets and variables.
#   5. Uploads this folder to the repository if it is empty; otherwise starts a deployment of what is there.
#   6. Follows the first run and reports whether it worked.
#
# Running it again is safe: existing resources and settings are reused or updated.
set -euo pipefail

# Same names as infra/provision.sh. If you changed PREFIX, RG or APP there, set them here too,
# for example: APP=my-app-name bash infra/github-setup.sh perceive1990/kdla-cms
PREFIX="${PREFIX:-kdla-cms}"
BRANCH="${BRANCH:-main}"

REPO="${1:-${GITHUB_REPO:-}}"
REPO="${REPO#https://github.com/}"
REPO="${REPO%.git}"
REPO="${REPO%/}"
if ! [[ "$REPO" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]]; then
  echo "Usage: bash infra/github-setup.sh <github-account>/<repository>   (for example: perceive1990/kdla-cms)"
  exit 1
fi

command -v az >/dev/null || { echo "The Azure CLI (az) is not installed. Run this in Azure Cloud Shell."; exit 1; }
command -v gh >/dev/null || { echo "The GitHub CLI (gh) is not installed. Run this in Azure Cloud Shell, or install it from https://cli.github.com"; exit 1; }
command -v git >/dev/null || { echo "git is not installed. Run this in Azure Cloud Shell."; exit 1; }
az account show --output none 2>/dev/null || { echo "Not signed in to Azure. Run: az login"; exit 1; }
if [ ! -f package.json ] || [ ! -f server.js ] || [ ! -f .github/workflows/azure-webapp.yml ]; then
  echo "Run this from the project folder (the one with package.json and the .github folder)."
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

SUB_ID=$(az account show --query id -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)
SUFFIX="${SUFFIX:-$(printf '%s' "$SUB_ID" | cksum | cut -d' ' -f1 | tail -c 6)}"
RG="${RG:-${PREFIX}-rg}"
APP="${APP:-${PREFIX}-${SUFFIX}}"
IDENTITY="${IDENTITY:-${PREFIX}-github}"

# ---- 1. The web app ------------------------------------------------------------------------------
if ! az webapp show --name "$APP" --resource-group "$RG" --output none 2>/dev/null; then
  echo "The web app $APP does not exist yet, so the Azure resources are created first."
  echo
  DEPLOY=no bash infra/provision.sh
  echo
  if [ -t 0 ]; then
    read -r -p "Write down the first login shown above, then press Enter to connect GitHub... " _
  fi
fi
WEBAPP_ID=$(az webapp show --name "$APP" --resource-group "$RG" --query id -o tsv)
LOCATION=$(az group show --name "$RG" --query location -o tsv)
echo "Azure web app: $APP (resource group $RG)"

# ---- 2. GitHub sign-in ---------------------------------------------------------------------------
if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  echo
  echo "Sign in to GitHub: copy the one-time code shown below, open https://github.com/login/device in your"
  echo "browser, paste the code and approve. (The \"workflow\" permission lets this script upload the deployment workflow.)"
  gh auth login --hostname github.com --git-protocol https --web --scopes workflow
fi

if ! gh repo view "$REPO" --json name >/dev/null 2>&1; then
  echo "Cannot find the GitHub repository $REPO with the GitHub account you signed in with."
  echo "Create it at https://github.com/new (leave it empty: no README, .gitignore or licence), or check the name."
  exit 1
fi
REPO=$(gh repo view "$REPO" --json nameWithOwner --jq .nameWithOwner) # exact spelling, which Azure compares
PERMISSION=$(gh repo view "$REPO" --json viewerPermission --jq .viewerPermission)
IS_EMPTY=$(gh repo view "$REPO" --json isEmpty --jq .isEmpty)
if [ "$PERMISSION" != "ADMIN" ]; then
  echo "Your GitHub account needs admin rights on $REPO to save its Actions secrets (it has: $PERMISSION)."
  exit 1
fi
echo "GitHub repository: https://github.com/$REPO"

# ---- 3. Managed identity that only this repository's main branch can use --------------------------
echo "Creating the deployment identity $IDENTITY..."
if [ "$(az provider show --namespace Microsoft.ManagedIdentity --query registrationState -o tsv 2>/dev/null)" != "Registered" ]; then
  az provider register --namespace Microsoft.ManagedIdentity --wait --output none
fi
if ! az identity show --name "$IDENTITY" --resource-group "$RG" --output none 2>/dev/null; then
  az identity create --name "$IDENTITY" --resource-group "$RG" --location "$LOCATION" --output none
fi
CLIENT_ID=$(az identity show --name "$IDENTITY" --resource-group "$RG" --query clientId -o tsv)
PRINCIPAL_ID=$(az identity show --name "$IDENTITY" --resource-group "$RG" --query principalId -o tsv)

SUBJECT="repo:${REPO}:ref:refs/heads/${BRANCH}"
CREDENTIAL="github-$(printf '%s' "$BRANCH" | tr -c 'A-Za-z0-9_-' '-')"
FC_ACTION=create
az identity federated-credential show --name "$CREDENTIAL" --identity-name "$IDENTITY" --resource-group "$RG" \
  --output none 2>/dev/null && FC_ACTION=update
az identity federated-credential "$FC_ACTION" --name "$CREDENTIAL" --identity-name "$IDENTITY" --resource-group "$RG" \
  --issuer "https://token.actions.githubusercontent.com" --subject "$SUBJECT" \
  --audiences "api://AzureADTokenExchange" --output none

echo "Allowing the identity to deploy to $APP only..."
ROLE_OK=no
NEW_ROLE=no
EXISTING=$(az role assignment list --scope "$WEBAPP_ID" \
  --query "length([?principalId=='$PRINCIPAL_ID' && roleDefinitionName=='Website Contributor'])" -o tsv 2>/dev/null || echo 0)
if [ "${EXISTING:-0}" != "0" ]; then
  ROLE_OK=yes
else
  for attempt in 1 2 3 4 5 6; do
    if az role assignment create --assignee-object-id "$PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
        --role "Website Contributor" --scope "$WEBAPP_ID" --output none 2>"$TMP/role-error"; then
      ROLE_OK=yes
      NEW_ROLE=yes
      break
    fi
    if grep -qiE 'AuthorizationFailed|does not have authorization|Forbidden' "$TMP/role-error"; then break; fi
    echo "  The new identity is not visible yet; trying again in 10 seconds (attempt $attempt of 6)..."
    sleep 10
  done
fi

# ---- 4. Secrets and variables in GitHub ----------------------------------------------------------
echo "Saving the connection details in GitHub (Settings > Secrets and variables > Actions)..."
gh variable set AZURE_WEBAPP_NAME --repo "$REPO" --body "$APP"
if [ "$ROLE_OK" = "yes" ]; then
  gh secret set AZURE_CLIENT_ID --repo "$REPO" --body "$CLIENT_ID"
  gh secret set AZURE_TENANT_ID --repo "$REPO" --body "$TENANT_ID"
  gh secret set AZURE_SUBSCRIPTION_ID --repo "$REPO" --body "$SUB_ID"
  gh secret delete AZURE_WEBAPP_PUBLISH_PROFILE --repo "$REPO" >/dev/null 2>&1 || true
else
  echo
  echo "Your Azure account is not allowed to grant roles (that needs Owner or User Access Administrator):"
  sed 's/^/  /' "$TMP/role-error" | head -5
  echo "Using a publish profile instead. This switches on basic authentication for deployments to $APP only."
  az resource update --resource-group "$RG" --namespace Microsoft.Web --resource-type basicPublishingCredentialsPolicies \
    --parent "sites/$APP" --name scm --set properties.allow=true --output none
  az webapp deployment list-publishing-profiles --name "$APP" --resource-group "$RG" --xml >"$TMP/profile.xml"
  gh secret set AZURE_WEBAPP_PUBLISH_PROFILE --repo "$REPO" <"$TMP/profile.xml"
  for name in AZURE_CLIENT_ID AZURE_TENANT_ID AZURE_SUBSCRIPTION_ID; do
    gh secret delete "$name" --repo "$REPO" >/dev/null 2>&1 || true
  done
  echo "Later, an Owner of the subscription can run this script again to switch to the safer OpenID Connect sign-in."
fi

if [ "$NEW_ROLE" = "yes" ]; then
  echo "Waiting one minute for Azure to apply the new permission..."
  sleep 60
fi

# ---- 5. The code ---------------------------------------------------------------------------------
if [ "$IS_EMPTY" = "true" ]; then
  echo "The repository is empty, so this folder is uploaded to it now."
  # Uploading a workflow file needs the "workflow" permission on the GitHub sign-in.
  SCOPES=$(gh api -i user 2>/dev/null | tr -d '\r' | sed -n 's/^[Xx]-[Oo][Aa]uth-[Ss]copes: *//p' | head -1)
  if [ -n "$SCOPES" ] && ! printf '%s' "$SCOPES" | tr ',' '\n' | tr -d ' ' | grep -qx workflow; then
    echo "GitHub needs one more permission to upload the workflow. Confirm the new code in your browser."
    gh auth refresh --hostname github.com --scopes workflow
  fi
  gh auth setup-git --hostname github.com
  [ -d .git ] || git init --quiet --initial-branch "$BRANCH"
  git config user.name >/dev/null || git config user.name "$(gh api user --jq '.name // .login')"
  git config user.email >/dev/null || git config user.email "$(gh api user --jq '"\(.id)+\(.login)@users.noreply.github.com"')"
  git add --all
  git commit --quiet -m "KDLA Case Management System $(node -p "require('./package.json').version" 2>/dev/null || echo '')" || true
  git branch -M "$BRANCH"
  git remote remove origin 2>/dev/null || true
  git remote add origin "https://github.com/${REPO}.git"
  git push --quiet -u origin "$BRANCH"
  echo "Uploaded. GitHub now tests the code and deploys it."
else
  echo "The repository already has code, so a deployment of its $BRANCH branch is started."
  if ! gh workflow run azure-webapp.yml --repo "$REPO" --ref "$BRANCH"; then
    echo "Could not start the workflow. Check that .github/workflows/azure-webapp.yml is on the $BRANCH branch in GitHub,"
    echo "then start it from https://github.com/$REPO/actions (Test and deploy > Run workflow)."
    exit 1
  fi
fi

# ---- 6. Follow the run ---------------------------------------------------------------------------
RUN_ID=""
for attempt in 1 2 3 4 5 6; do
  sleep 5
  RUN_ID=$(gh run list --repo "$REPO" --workflow azure-webapp.yml --branch "$BRANCH" --limit 1 \
    --json databaseId --jq '.[0].databaseId // empty' 2>/dev/null || true)
  [ -n "$RUN_ID" ] && break
done

RESULT=unknown
if [ -n "$RUN_ID" ]; then
  echo
  echo "Following the run: tests, then deployment and a health check (usually 3 to 8 minutes)."
  echo "You can close this window at any time; the run carries on at https://github.com/$REPO/actions"
  if gh run watch "$RUN_ID" --repo "$REPO" --exit-status; then RESULT=ok; else RESULT=failed; fi
fi

echo
case "$RESULT" in
  ok)
    echo "Done. The site is live at https://${APP}.azurewebsites.net"
    ;;
  failed)
    echo "The run did not succeed. Open https://github.com/$REPO/actions, click the run and read the step marked in red."
    if [ "$NEW_ROLE" = "yes" ]; then
      echo "If the error mentions authorization, Azure was still applying the new permission: wait five minutes,"
      echo "then click \"Re-run all jobs\" on that page."
    fi
    ;;
  *)
    echo "Follow the deployment at https://github.com/$REPO/actions"
    ;;
esac
echo
echo "From now on, every change pushed to the $BRANCH branch of https://github.com/$REPO is tested and, when the"
echo "tests pass, deployed to https://${APP}.azurewebsites.net automatically."
