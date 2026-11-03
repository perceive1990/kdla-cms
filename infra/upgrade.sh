#!/usr/bin/env bash
# Moves the KDLA Case Management System off the free limits once the Microsoft nonprofit Azure grant
# (or another credit) is active on the subscription:
#   - App Service plan F1 -> B1: the site no longer sleeps and has no daily CPU quota (Always On)
#   - Azure Blob Storage for photos and attachments (files already saved are copied across automatically)
#   - Daily Cosmos DB backups kept for 7 days (instead of the default 4 hourly, kept 8 hours)
#
# Run in Azure Cloud Shell (Bash) from the project folder:
#   git clone https://github.com/perceive1990/kdla-cms && cd kdla-cms && bash infra/upgrade.sh
# Skip the question (for example when pasting): CONFIRM=yes bash infra/upgrade.sh
# Back to the free plan at any time (files stay in Blob storage):
#   TIER=F1 bash infra/upgrade.sh
#
# These services are charged to the subscription. The grant pays for them while it has credit; after that
# they are billed at normal prices, so set a budget alert (the script prints how).
set -euo pipefail

RG="${RG:-kdla-cms-rg}"
TIER="${TIER:-B1}"                       # B1 (Basic) or F1 (Free)
BACKUP_HOURS="${BACKUP_HOURS:-24}"       # how often Cosmos DB takes a backup
BACKUP_KEEP_HOURS="${BACKUP_KEEP_HOURS:-168}" # how long backups are kept (168 hours = 7 days)

command -v az >/dev/null || { echo "The Azure CLI (az) is not installed. Use Azure Cloud Shell."; exit 1; }
az account show --output none 2>/dev/null || { echo "Not logged in. Run: az login"; exit 1; }

APP="${APP:-$(az webapp list -g "$RG" --query "[0].name" -o tsv)}"
[ -n "$APP" ] || { echo "No web app found in resource group $RG. Set RG=... or APP=..."; exit 1; }
# The plan's id is called serverFarmId (newer Azure CLI) or appServicePlanId (older).
PLAN_ID=$(az webapp show -g "$RG" -n "$APP" --query "serverFarmId || appServicePlanId" -o tsv)
[ -n "$PLAN_ID" ] || { echo "Could not find the App Service plan of $APP. Nothing changed."; exit 1; }
PLAN=$(basename "$PLAN_ID")
COSMOS="${COSMOS:-$(az cosmosdb list -g "$RG" --query "[0].name" -o tsv)}"
LOCATION=$(az group show -n "$RG" --query location -o tsv)
SUFFIX="${APP##*-}"
STORAGE="${STORAGE:-kdlacms${SUFFIX}}"
CURRENT=$(az appservice plan show --ids "$PLAN_ID" --query sku.name -o tsv)
[ -n "$CURRENT" ] || { echo "Could not read the plan $PLAN. Nothing changed."; exit 1; }

echo "Subscription:  $(az account show --query name -o tsv)"
echo "Web app:       $APP (plan $PLAN, now $CURRENT)"
echo "Database:      $COSMOS"
echo ""

if [ "$TIER" = "F1" ]; then
  echo "Moving the web app back to the free F1 plan (Always On off). Blob storage and backups are kept."
  az webapp config set -g "$RG" -n "$APP" --always-on false --output none
  az appservice plan update --ids "$PLAN_ID" --sku F1 --output none
  echo "Done. The site is on F1 again."
  exit 0
fi

echo "This turns on paid Azure services for $APP:"
echo "  1. App Service plan $CURRENT -> $TIER with Always On"
echo "  2. Storage account $STORAGE for photos and attachments"
echo "  3. Cosmos DB backups every ${BACKUP_HOURS} hours, kept ${BACKUP_KEEP_HOURS} hours"
echo "Check current prices at https://azure.microsoft.com/pricing/calculator before you continue."
if [ "${CONFIRM:-}" != "yes" ]; then
  answer=""
  while [ -z "$answer" ]; do read -r -p "Type UPGRADE and press Enter to continue (or NO to stop): " answer; done
  [ "$(printf '%s' "$answer" | tr '[:lower:]' '[:upper:]' | tr -d ' ')" = "UPGRADE" ] || { echo "Nothing changed."; exit 0; }
fi

echo ""
echo "1/3 App Service plan -> $TIER..."
az appservice plan update --ids "$PLAN_ID" --sku "$TIER" --output none
az webapp config set -g "$RG" -n "$APP" --always-on true --output none

echo "2/3 Blob storage: $STORAGE..."
if [ "$(az provider show --namespace Microsoft.Storage --query registrationState -o tsv 2>/dev/null)" != "Registered" ]; then
  az provider register --namespace Microsoft.Storage --wait --output none
fi
if ! az storage account show -n "$STORAGE" -g "$RG" --output none 2>/dev/null; then
  az storage account create -n "$STORAGE" -g "$RG" -l "$LOCATION" --sku Standard_LRS --kind StorageV2 \
    --min-tls-version TLS1_2 --allow-blob-public-access false --https-only true --output none
fi
BLOB_CONN=$(az storage account show-connection-string -n "$STORAGE" -g "$RG" -o tsv)
# Changing a setting restarts the app; on start it copies files already on the disk to Blob storage.
az webapp config appsettings set -g "$RG" -n "$APP" --settings "AZURE_STORAGE_CONNECTION_STRING=$BLOB_CONN" --output none

echo "3/3 Cosmos DB backups..."
if ! az cosmosdb update -n "$COSMOS" -g "$RG" --backup-interval $((BACKUP_HOURS * 60)) --backup-retention "$BACKUP_KEEP_HOURS" --output none; then
  echo "   Could not change the backup policy (the default automatic backups stay on). Everything else is done."
fi

echo ""
echo "Checking the site..."
URL="https://$(az webapp show -g "$RG" -n "$APP" --query defaultHostName -o tsv)"
for i in $(seq 1 20); do
  if curl -fsS "$URL/healthz?db=1" >/dev/null 2>&1; then echo "   $URL is up."; break; fi
  sleep 10
done

cat <<EOF

Done. The site no longer sleeps, files are kept in Blob storage, and backups are kept for $((BACKUP_KEEP_HOURS / 24)) days.

Set a spending alert now (Azure portal):
  Cost Management > Budgets > Add > monthly amount, for example USD 150,
  with an email alert at 80%. The grant is USD 2,000 for one year and must be renewed every year.

To go back to the free plan:  TIER=F1 bash infra/upgrade.sh
EOF
