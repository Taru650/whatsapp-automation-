#!/bin/sh
# Import credentials + all generated workflows into n8n, then publish them.
# Run with n8n STOPPED (the CLI writes to n8n's DB directly), then start n8n.
# POSIX sh on purpose: it also runs inside the n8n Docker image (compose "import" job).
#
#   N8N_BIN   n8n command (default: n8n)
#   POSTGRES_HOST/PORT/DB/USER/PASSWORD   the citizen_bot DB the workflows use
#   SMTP_HOST/PORT/USER/PASSWORD/SECURE   optional, for the daily report e-mail
#   ENV       test -> also publish core-99-test-harness; otherwise it stays unpublished
set -eu
cd "$(dirname "$0")/.."
N8N=${N8N_BIN:-n8n}

node scripts/build_workflows.mjs --check

creds=$(mktemp)
trap 'rm -f "$creds"' EXIT
# Built with node so passwords containing quotes/backslashes stay valid JSON.
: "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}"
node -e '
const e = process.env;
const creds = [{ id: "PgCitizenBot0001", name: "citizen_bot", type: "postgres", data: {
  host: e.POSTGRES_HOST || "postgres", port: Number(e.POSTGRES_PORT || 5432), database: e.POSTGRES_DB || "citizen_bot",
  user: e.POSTGRES_USER || "bot", password: e.POSTGRES_PASSWORD, ssl: "disable", allowUnauthorizedCerts: false, sshTunnel: false } },
  // SMTP for the daily report e-mail; only used when SMTP_HOST and REPORT_EMAIL_TO are set
  { id: "SmtpReport000001", name: "report_smtp", type: "smtp", data: {
  host: e.SMTP_HOST || "localhost", port: Number(e.SMTP_PORT || 587), user: e.SMTP_USER || "", password: e.SMTP_PASSWORD || "",
  secure: e.SMTP_SECURE === "true", disableStartTls: e.SMTP_DISABLE_STARTTLS === "true" } }];
process.stdout.write(JSON.stringify(creds));
' > "$creds"
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
