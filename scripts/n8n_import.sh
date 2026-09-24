#!/bin/sh
# Import credentials + all generated workflows into n8n, then publish them.
# Run with n8n STOPPED (the CLI writes to n8n's DB directly), then start n8n.
# POSIX sh on purpose: it also runs inside the n8n Docker image (compose "import" job).
#
#   N8N_BIN   n8n command (default: n8n)
#   POSTGRES_HOST/PORT/DB/USER/PASSWORD   the citizen_bot DB the workflows use
#   ENV       test -> also publish core-99-test-harness; otherwise it stays unpublished
set -eu
cd "$(dirname "$0")/.."
N8N=${N8N_BIN:-n8n}

node scripts/build_workflows.mjs --check

creds=$(mktemp)
trap 'rm -f "$creds"' EXIT
cat > "$creds" <<JSON
[{"id": "PgCitizenBot0001", "name": "citizen_bot", "type": "postgres",
  "data": {"host": "${POSTGRES_HOST:-postgres}", "port": ${POSTGRES_PORT:-5432},
           "database": "${POSTGRES_DB:-citizen_bot}", "user": "${POSTGRES_USER:-bot}",
           "password": "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}", "ssl": "disable",
           "allowUnauthorizedCerts": false, "sshTunnel": false}}]
JSON
$N8N import:credentials --input="$creds"

# Re-importing over published workflows fails, so unpublish everything first.
$N8N unpublish:workflow --all >/dev/null 2>&1 || true
$N8N import:workflow --separate --input=n8n/workflows/services
$N8N import:workflow --separate --input=n8n/workflows/core

for f in n8n/workflows/services/*.json n8n/workflows/core/*.json; do
  id=$(node -e "console.log(require('./$f').id)")
  if [ "$id" = "CoreHarness00001" ] && [ "${ENV:-}" != "test" ]; then
    echo "skipped (ENV != test): $f"
    continue
  fi
  $N8N publish:workflow --id="$id" >/dev/null
  echo "published: $f ($id)"
done
echo "Done. (Re)start n8n for the changes to take effect."
