#!/usr/bin/env bash
# Backup -> restore drill against a local Postgres (plan M2 gate).
# Backs up citizen_bot, restores it as citizen_bot_drill, and compares every
# table's row count and a content checksum. Also proves a wrong passphrase fails,
# and runs the retention purge on the restored COPY (M3 gate: "purge verified on
# a copy"): nothing older than the cutoff survives, nothing newer is touched, and
# every purged day is archived first.
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
      where table_schema in ('core', 'svc_mela', 'analytics') and table_type = 'BASE TABLE') x" |
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

# Purge on the copy with the shortest allowed retention (30 days), so real-shaped
# data actually gets purged. Production is never touched.
psql -d citizen_bot_drill -XAtq -v ON_ERROR_STOP=1 <<'SQL'
update core.settings set value = '30' where key = 'retention_days';
create temp table before as
  select (select count(*) from core.message_log where ts >= now() - interval '30 days') as recent,
         (select count(distinct (ts at time zone 'Asia/Kolkata')::date) from core.message_log
           where ts < now() - interval '30 days' and direction = 'in') as old_days;
select core.run_purge() \gset p_
do $$
begin
  assert (select count(*) from core.message_log where ts < now() - interval '30 days') = 0, 'old message_log rows survived';
  assert (select count(*) from core.feedback   where ts < now() - interval '30 days') = 0, 'old feedback survived';
  assert (select count(*) from core.unanswered where ts < now() - interval '30 days') = 0, 'old unanswered survived';
  assert (select count(*) from core.citizens   where last_seen < now() - interval '30 days') = 0, 'old citizens survived';
  -- (a few seconds pass between the counts, so allow rows that crossed the line)
  assert (select count(*) from core.message_log) >= (select recent from before) - 5, 'recent rows were purged';
  assert (select count(*) from analytics.daily_archive where day < (now() at time zone 'Asia/Kolkata')::date - 29)
         >= (select old_days from before), 'a purged day was not archived';
end $$;
select 'purge on the copy OK: ' || :'p_run_purge';
SQL

if BACKUP_PASSPHRASE=wrong scripts/restore.sh >/dev/null 2>&1; then
  echo "FAILED: restore worked with a wrong passphrase" >&2; exit 1
fi
echo "wrong passphrase correctly rejected"
