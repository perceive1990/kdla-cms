#!/usr/bin/env bash
# Creates everything the KDLA Case Management System needs on Azure, on free tiers where possible:
#   - Azure Cosmos DB for NoSQL account with the free tier discount (1000 RU/s + 25 GB)
#   - App Service plan F1 (Free, Linux) + Web App running Node.js 22
#   - (optional) Storage account for case file attachments
#
# Easiest on Windows: open Azure Cloud Shell (Bash) in the Azure portal, upload the project zip,
#   unzip -o kdla-case-management-v2.2.1.zip && cd kdla-cms && bash infra/provision.sh
# To deploy from GitHub afterwards (every push to main), run infra/github-setup.sh as well (see README).
# Elsewhere: install the Azure CLI (https://aka.ms/azcli), run `az login`, then run this from the project folder.
#
# Re-running is safe: resources are found again by name, secrets are kept, and the latest code is deployed.
set -euo pipefail

# ---- Settings you can change (set them before the command, e.g. LOCATION=northeurope bash infra/provision.sh)
PREFIX="${PREFIX:-kdla-cms}"
LOCATION="${LOCATION:-southafricanorth}"   # nearest Azure region to Zambia; try northeurope if a free plan is refused
COSMOS_MODE="${COSMOS_MODE:-free}"         # "free" = free tier (one per subscription), "serverless" = pay per use
USE_BLOB="${USE_BLOB:-yes}"                # "no" = keep attachments on the App Service disk (/home, about 1 GB on F1)
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
NODE_RUNTIME="${NODE_RUNTIME:-NODE:22-lts}"
REQUIRE_2FA="${REQUIRE_2FA:-admins}"       # none, admins or all
DEPLOY="${DEPLOY:-yes}"                     # "no" = only create the Azure resources (GitHub Actions deploys the code)
# ------------------------------------------------------------------------------

command -v az >/dev/null || { echo "The Azure CLI (az) is not installed. Use Azure Cloud Shell or install it from https://aka.ms/azcli"; exit 1; }
command -v node >/dev/null || { echo "Node.js is needed to package the app. Use Azure Cloud Shell (it has Node.js) or install Node.js 20 or newer."; exit 1; }
az account show --output none 2>/dev/null || { echo "Not logged in. Run: az login"; exit 1; }
if [ ! -f package.json ] || [ ! -f server.js ]; then echo "Run this from the project folder (the one with package.json)."; exit 1; fi

# A stable suffix per subscription keeps names globally unique and the same on every run.
SUB_ID=$(az account show --query id -o tsv)
SUFFIX="${SUFFIX:-$(printf '%s' "$SUB_ID" | cksum | cut -d' ' -f1 | tail -c 6)}"
RG="${RG:-${PREFIX}-rg}"
COSMOS="${COSMOS:-${PREFIX}-db-${SUFFIX}}"
PLAN="${PLAN:-${PREFIX}-plan}"
APP="${APP:-${PREFIX}-${SUFFIX}}"           # becomes https://<APP>.azurewebsites.net
STORAGE="${STORAGE:-kdlacms${SUFFIX}}"

echo "Subscription: $(az account show --query name -o tsv)"
echo "Resource group: $RG ($LOCATION)"
az group create --name "$RG" --location "$LOCATION" --output none

echo "Cosmos DB account: $COSMOS ($COSMOS_MODE). The first time this takes 5 to 10 minutes..."
if ! az cosmosdb show --name "$COSMOS" --resource-group "$RG" --output none 2>/dev/null; then
  CREATE_ARGS=(--name "$COSMOS" --resource-group "$RG" --kind GlobalDocumentDB --default-consistency-level Session
    --locations regionName="$LOCATION" failoverPriority=0 isZoneRedundant=False --output none)
  if [ "$COSMOS_MODE" = "serverless" ]; then
    CREATE_ARGS+=(--capabilities EnableServerless)
  else
    CREATE_ARGS+=(--enable-free-tier true)
  fi
  if ! az cosmosdb create "${CREATE_ARGS[@]}"; then
    echo ""
    echo "Could not create the Cosmos DB account."
    echo "If the error mentions the free tier: only one free-tier Cosmos DB account is allowed per subscription."
    echo "Either delete the other free-tier account, or run again with COSMOS_MODE=serverless (pay per use, usually"
    echo "a few dollars a month or less for a small team). If the region is the problem, run again with LOCATION=northeurope."
    exit 1
  fi
fi
COSMOS_CONN=$(az cosmosdb keys list --name "$COSMOS" --resource-group "$RG" --type connection-strings \
  --query "connectionStrings[0].connectionString" -o tsv)
THROUGHPUT=1000
[ "$COSMOS_MODE" = "serverless" ] && THROUGHPUT=0

BLOB_CONN=""
if [ "$USE_BLOB" = "yes" ]; then
  echo "Storage account for attachments: $STORAGE"
  if ! az storage account show --name "$STORAGE" --resource-group "$RG" --output none 2>/dev/null; then
    az storage account create --name "$STORAGE" --resource-group "$RG" --location "$LOCATION" \
      --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 --allow-blob-public-access false \
      --https-only true --output none
  fi
  BLOB_CONN=$(az storage account show-connection-string --name "$STORAGE" --resource-group "$RG" -o tsv)
fi

echo "App Service plan (F1 Free, Linux): $PLAN"
if ! az appservice plan show --name "$PLAN" --resource-group "$RG" --output none 2>/dev/null; then
  if ! az appservice plan create --name "$PLAN" --resource-group "$RG" --location "$LOCATION" --sku F1 --is-linux --output none; then
    echo "Could not create a free (F1) Linux plan. A subscription can usually have only one free Linux plan per region."
    echo "Delete the other free plan, or run again with LOCATION=northeurope."
    exit 1
  fi
fi

APP_IS_NEW=no
echo "Web App: $APP"
if ! az webapp show --name "$APP" --resource-group "$RG" --output none 2>/dev/null; then
  az webapp create --name "$APP" --resource-group "$RG" --plan "$PLAN" --runtime "$NODE_RUNTIME" --output none
  APP_IS_NEW=yes
fi
az webapp update --name "$APP" --resource-group "$RG" --https-only true --output none
az webapp config set --name "$APP" --resource-group "$RG" --ftps-state Disabled --min-tls-version 1.2 \
  --http20-enabled true --startup-file "npm start" --output none

# Keep secrets that already exist, so a re-run does not sign everyone out or change the admin password.
existing() { az webapp config appsettings list --name "$APP" --resource-group "$RG" --query "[?name=='$1'].value | [0]" -o tsv 2>/dev/null || true; }
SESSION_SECRET="$(existing SESSION_SECRET)"
if [ -z "$SESSION_SECRET" ] || [ "$SESSION_SECRET" = "None" ]; then SESSION_SECRET="$(openssl rand -hex 32)"; fi

SETTINGS=(
  NODE_ENV=production
  SCM_DO_BUILD_DURING_DEPLOYMENT=true
  DB_DRIVER=cosmos
  "COSMOS_CONNECTION_STRING=$COSMOS_CONN"
  COSMOS_DATABASE=kdla-cms
  "COSMOS_THROUGHPUT=$THROUGHPUT"
  "AZURE_STORAGE_CONNECTION_STRING=$BLOB_CONN"
  UPLOAD_DIR=/home/data/uploads
  "SESSION_SECRET=$SESSION_SECRET"
  "REQUIRE_2FA=$REQUIRE_2FA"
  DISPLAY_TIMEZONE=Africa/Lusaka
)
ADMIN_NOTE="Existing administrator accounts are unchanged."
if [ "$APP_IS_NEW" = "yes" ]; then
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | cut -c1-16)}"
  SETTINGS+=("ADMIN_USERNAME=$ADMIN_USERNAME" "ADMIN_PASSWORD=$ADMIN_PASSWORD")
  ADMIN_NOTE="First login: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}
  Write this down now. You will be asked to choose a new password, then to set up two-step verification.
  Afterwards remove ADMIN_PASSWORD under App Service > Settings > Environment variables."
fi
az webapp config appsettings set --name "$APP" --resource-group "$RG" --output none --settings "${SETTINGS[@]}"

if [ "$DEPLOY" = "yes" ]; then
  echo "Packaging and deploying the app..."
  TMPDIR_ZIP="$(mktemp -d)"
  TMPZIP="$TMPDIR_ZIP/app.zip"
  node scripts/package.js "$TMPZIP"
  az webapp deploy --name "$APP" --resource-group "$RG" --src-path "$TMPZIP" --type zip --output none
  rm -rf "$TMPDIR_ZIP"
  DONE_NOTE="Done."
else
  DONE_NOTE="The Azure resources are ready. GitHub Actions will deploy the code."
fi

cat <<EOF

${DONE_NOTE}
  Site:  https://${APP}.azurewebsites.net
  API:   https://${APP}.azurewebsites.net/api/v1  (documentation at /api/docs)
  ${ADMIN_NOTE}

The free plan sleeps when nobody uses it, so the first visit after a quiet period can take 20 to 40 seconds.
Check the database connection any time at https://${APP}.azurewebsites.net/healthz?db=1
EOF
