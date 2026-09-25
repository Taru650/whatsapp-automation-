#!/usr/bin/env bash
# Restore both databases from backup.sh output (the newest files in BACKUP_DIR,
# or the stamp given as $1, e.g. 20261110-0230).
#
#   BACKUP_PASSPHRASE  the same passphrase used for the backup
#   PG_RESTORE         restore command (default: through the compose "postgres" service)
#   PSQL               psql command (same default)
#   RESTORE_SUFFIX     restore into <db><suffix> instead of overwriting (used by the drill)
#
# Stop n8n first (docker compose stop n8n) so nothing writes during the restore.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE}"
DIR=${BACKUP_DIR:-/var/backups/citizen-bot}
PG_USER=${POSTGRES_USER:-bot}
PG_RESTORE=${PG_RESTORE:-docker compose exec -T postgres pg_restore -U $PG_USER}
PSQL=${PSQL:-docker compose exec -T postgres psql -U $PG_USER}
STAMP=${1:-$(ls -1 "$DIR"/citizen_bot-*.dump.enc | sed -E 's/.*citizen_bot-(.*)\.dump\.enc/\1/' | sort | tail -1)}
SUFFIX=${RESTORE_SUFFIX:-}

dec() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$1"; }

for db in ${BACKUP_DBS:-citizen_bot n8n}; do
  file="$DIR/$db-$STAMP.dump.enc"
  [[ -f "$file" ]] || { echo "missing $file" >&2; exit 1; }
  target="$db$SUFFIX"
  $PSQL -d postgres -v ON_ERROR_STOP=1 -q -c "drop database if exists \"$target\" with (force)" -c "create database \"$target\""
  dec "$file" | $PG_RESTORE -d "$target" --no-owner --exit-on-error
  echo "restored $file -> $target"
done
echo "Done. For a real restore: docker compose run --rm import && docker compose up -d"
