#!/usr/bin/env bash
# Nightly backup: both databases + .env, encrypted, rotated, optionally copied off-site.
#
#   BACKUP_PASSPHRASE  required; store it in the office password safe (NOT on this machine only)
#   BACKUP_DIR         default /var/backups/citizen-bot
#   BACKUP_REMOTE      optional rclone target, e.g. gdrive:citizen-bot-backups
#   KEEP_DAYS          default 14
#   PG_DUMP            dump command (default: through the compose "postgres" service)
#   BACKUP_DBS         databases to dump (default: citizen_bot n8n)
#
# cron (as root, 02:30 IST):  30 2 * * *  cd /opt/citizen-bot && scripts/backup.sh >> /var/log/citizen-bot-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
: "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE}"
DIR=${BACKUP_DIR:-/var/backups/citizen-bot}
KEEP=${KEEP_DAYS:-14}
PG_USER=${POSTGRES_USER:-bot}
PG_DUMP=${PG_DUMP:-docker compose exec -T postgres pg_dump -U $PG_USER}
STAMP=$(date +%Y%m%d-%H%M)
mkdir -p "$DIR"
umask 077

enc() { openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -out "$1"; }

for db in ${BACKUP_DBS:-citizen_bot n8n}; do
  out="$DIR/$db-$STAMP.dump.enc"
  $PG_DUMP -Fc "$db" | enc "$out"
  [[ -s "$out" ]] || { echo "backup of $db is empty" >&2; exit 1; }
  echo "ok  $out ($(du -h "$out" | cut -f1))"
done
if [[ -f .env ]]; then
  enc "$DIR/env-$STAMP.enc" < .env
  echo "ok  $DIR/env-$STAMP.enc"
fi

find "$DIR" -name '*.enc' -mtime +"$KEEP" -delete
if [[ -n "${BACKUP_REMOTE:-}" ]]; then
  rclone copy "$DIR" "$BACKUP_REMOTE" --max-age 25h
  echo "copied off-site to $BACKUP_REMOTE"
fi
