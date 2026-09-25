#!/usr/bin/env bash
# Backup -> restore drill against a local Postgres (plan M2 gate).
# Backs up citizen_bot, restores it as citizen_bot_drill, and compares every
# table's row count and a content checksum. Also proves a wrong passphrase fails.
# Uses the PG* env vars of the running dev database.
set -euo pipefail
cd "$(dirname "$0")/.."
export BACKUP_DIR=$(mktemp -d) BACKUP_PASSPHRASE=drill-$RANDOM BACKUP_DBS=citizen_bot
export PG_DUMP="pg_dump" PG_RESTORE="pg_restore" PSQL="psql" RESTORE_SUFFIX=_drill
trap 'rm -rf "$BACKUP_DIR"; psql -d postgres -Xqc "drop database if exists citizen_bot_drill with (force)" >/dev/null' EXIT

fingerprint() {  # "schema.table rows md5" for every table in our schemas
  psql -d "$1" -XAt -c "
    select string_agg(t, E'\n' order by t) from (
      select format('%s.%s', table_schema, table_name) as t from information_schema.tables
      where table_schema in ('core', 'svc_mela') and table_type = 'BASE TABLE') x" |
  while read -r t; do
    echo "$t $(psql -d "$1" -XAt -c "select count(*) || ' ' || md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from $t x")"
  done
}

start=$(date +%s)
scripts/backup.sh >/dev/null
scripts/restore.sh >/dev/null
elapsed=$(( $(date +%s) - start ))

if diff <(fingerprint citizen_bot) <(fingerprint citizen_bot_drill) >/dev/null; then
  echo "restore drill OK: $(fingerprint citizen_bot | wc -l) tables identical, $(fingerprint citizen_bot | awk '{s+=$2} END {print s}') rows, ${elapsed}s"
else
  echo "restore drill FAILED: restored data differs" >&2
  diff <(fingerprint citizen_bot) <(fingerprint citizen_bot_drill) >&2 || true
  exit 1
fi
if BACKUP_PASSPHRASE=wrong scripts/restore.sh >/dev/null 2>&1; then
  echo "FAILED: restore worked with a wrong passphrase" >&2; exit 1
fi
echo "wrong passphrase correctly rejected"
