#!/usr/bin/env bash
# Moves the KDLA Reports and Case Documentation system (and any other resource groups you name) into another Azure
# subscription, for example the "Azure Sponsorship" subscription created by the nonprofit grant.
# The web address, database, files, settings and logins stay the same; Azure moves the resources as they are.
#
# Run in Azure Cloud Shell (Bash) from the project folder:
#   git clone https://github.com/perceive1990/kdla-cms && cd kdla-cms && bash infra/move-subscription.sh
# Several resource groups:   RESOURCE_GROUPS="kdla-cms-rg other-app-rg" bash infra/move-subscription.sh
# Choose the target directly: TARGET="<subscription id or name>" bash infra/move-subscription.sh
#
# What happens:
#   1. Azure checks that everything can move (nothing changes if it cannot).
#   2. The resources move. The site keeps running; settings cannot be changed for the few minutes this takes.
#   3. The GitHub deploy connection is set up again in the new subscription (its sign-in identity cannot move).
set -euo pipefail

RESOURCE_GROUPS="${RESOURCE_GROUPS:-kdla-cms-rg}"
command -v az >/dev/null || { echo "The Azure CLI (az) is not installed. Use Azure Cloud Shell."; exit 1; }
az account show --output none 2>/dev/null || { echo "Not logged in. Run: az login"; exit 1; }

SOURCE_ID=$(az account show --query id -o tsv)
SOURCE_NAME=$(az account show --query name -o tsv)

if [ -z "${TARGET:-}" ]; then
  echo "Your subscriptions:"
  az account list --query "[].{Name:name, Id:id, State:state}" -o table
  echo ""
  read -r -p "Name or id of the subscription to move INTO (for example the Azure Sponsorship one): " TARGET
fi
TARGET_ID=$(az account show --subscription "$TARGET" --query id -o tsv)
TARGET_NAME=$(az account show --subscription "$TARGET" --query name -o tsv)
[ "$TARGET_ID" != "$SOURCE_ID" ] || { echo "That is the subscription the apps are already in. Nothing to move."; exit 0; }

echo ""
echo "From: $SOURCE_NAME"
echo "To:   $TARGET_NAME"
echo "Resource groups: $RESOURCE_GROUPS"

# Services must be switched on in the new subscription before resources of that kind can arrive.
for ns in Microsoft.DocumentDB Microsoft.Web Microsoft.Storage Microsoft.ManagedIdentity; do
  if [ "$(az provider show --subscription "$TARGET_ID" --namespace "$ns" --query registrationState -o tsv 2>/dev/null)" != "Registered" ]; then
    echo "Switching on $ns in the new subscription..."
    az provider register --subscription "$TARGET_ID" --namespace "$ns" --wait --output none
  fi
done

FREE_COSMOS=$(az cosmosdb list --subscription "$TARGET_ID" --query "[?enableFreeTier] | length(@)" -o tsv 2>/dev/null || echo 0)

declare -A MOVE_IDS IDENTITIES
for RG in $RESOURCE_GROUPS; do
  az group show -n "$RG" --subscription "$SOURCE_ID" --output none 2>/dev/null || { echo "Resource group $RG not found in $SOURCE_NAME."; exit 1; }
  # Managed identities cannot move between subscriptions; they are recreated afterwards.
  MOVE_IDS[$RG]=$(az resource list -g "$RG" --subscription "$SOURCE_ID" \
    --query "[?type!='Microsoft.ManagedIdentity/userAssignedIdentities'].id" -o tsv | tr '\n' ' ')
  IDENTITIES[$RG]=$(az resource list -g "$RG" --subscription "$SOURCE_ID" \
    --query "[?type=='Microsoft.ManagedIdentity/userAssignedIdentities'].name" -o tsv | tr '\n' ' ')
  if [ "$FREE_COSMOS" != "0" ] && az cosmosdb list -g "$RG" --subscription "$SOURCE_ID" --query "[?enableFreeTier] | length(@)" -o tsv | grep -qv '^0$'; then
    echo "The new subscription already has a free-tier Cosmos DB account, and only one is allowed per subscription."
    echo "Delete that account, or keep the database where it is. Nothing was moved."
    exit 1
  fi
  echo ""
  echo "$RG will move:"
  for id in ${MOVE_IDS[$RG]}; do echo "  - $(basename "$id")"; done
  [ -n "${IDENTITIES[$RG]}" ] && echo "  (recreated afterwards: ${IDENTITIES[$RG]})"
done

echo ""
if [ "${CONFIRM:-}" != "yes" ]; then
  answer=""
  while [ -z "$answer" ]; do read -r -p "Type MOVE and press Enter to continue (or NO to stop): " answer; done
  [ "$(printf '%s' "$answer" | tr '[:lower:]' '[:upper:]' | tr -d ' ')" = "MOVE" ] || { echo "Nothing changed."; exit 0; }
fi

for RG in $RESOURCE_GROUPS; do
  [ -n "${MOVE_IDS[$RG]}" ] || continue
  LOCATION=$(az group show -n "$RG" --subscription "$SOURCE_ID" --query location -o tsv)
  az group create -n "$RG" -l "$LOCATION" --subscription "$TARGET_ID" --output none
  TARGET_RG="/subscriptions/$TARGET_ID/resourceGroups/$RG"
  SOURCE_RG="/subscriptions/$SOURCE_ID/resourceGroups/$RG"

  echo "Checking that $RG can move (a minute or two)..."
  BODY=$(printf '{"resources": [%s], "targetResourceGroup": "%s"}' \
    "$(for id in ${MOVE_IDS[$RG]}; do printf '"%s",' "$id"; done | sed 's/,$//')" "$TARGET_RG")
  if ! az rest --method post --uri "https://management.azure.com${SOURCE_RG}/validateMoveResources?api-version=2021-04-01" \
      --body "$BODY" --output none 2>/tmp/kdla-move-check; then
    echo "Azure says $RG cannot move yet:"; sed 's/^/  /' /tmp/kdla-move-check | head -20
    echo "Nothing was moved. Paste this message to get help."
    exit 1
  fi

  echo "Moving $RG (usually 5 to 15 minutes; the site keeps running)..."
  # shellcheck disable=SC2086
  az resource move --destination-subscription-id "$TARGET_ID" --destination-group "$RG" --ids ${MOVE_IDS[$RG]} --output none
  echo "  $RG moved."
done

az account set --subscription "$TARGET_ID"
if [[ " $RESOURCE_GROUPS " == *" kdla-cms-rg "* ]]; then
  echo ""
  echo "Setting up the GitHub deploy connection in the new subscription..."
  # Pass the existing names so nothing new is created: names would otherwise be worked out from the new subscription id.
  APP_NAME=$(az webapp list -g kdla-cms-rg --query "[0].name" -o tsv)
  REPO="${GITHUB_REPO:-perceive1990/kdla-cms}"
  if ! APP="$APP_NAME" SUFFIX="${APP_NAME##*-}" bash infra/github-setup.sh "$REPO"; then
    echo "  Finish the GitHub connection with:"
    echo "  APP=$APP_NAME SUFFIX=${APP_NAME##*-} bash infra/github-setup.sh $REPO"
  fi
fi

cat <<EOF

Done. Your apps now run in "$TARGET_NAME".
Old sign-in identities left behind in "$SOURCE_NAME" (safe to delete in the portal): ${IDENTITIES[*]:-none}
Empty resource groups may also remain there; delete them once you have checked the apps work.
EOF
