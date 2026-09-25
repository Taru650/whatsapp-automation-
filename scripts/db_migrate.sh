#!/usr/bin/env bash
# Apply sql/*.sql in filename order. Every file is idempotent, so this runs on
# every deploy. Connection comes from the standard libpq env vars
# (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE) or $DATABASE_URL.
set -euo pipefail
cd "$(dirname "$0")/.."
for f in sql/*.sql; do
  echo "applying $f"
  PGOPTIONS="-c client_min_messages=warning" psql ${DATABASE_URL:+"$DATABASE_URL"} -X -q -v ON_ERROR_STOP=1 -o /dev/null -f "$f"
done

# Admin numbers (ADMIN_WA_NUMBERS) are stored only as hashes.
if [[ -n "${ADMIN_WA_NUMBERS:-}" && -n "${PHONE_HASH_SECRET:-}" ]]; then
  # psql only interpolates :'vars' in scripts read from stdin/files, not with -c
  echo "select core.set_admins(:'nums', :'secret');" | psql ${DATABASE_URL:+"$DATABASE_URL"} -X -q -v ON_ERROR_STOP=1 \
    -o /dev/null -v nums="$ADMIN_WA_NUMBERS" -v secret="$PHONE_HASH_SECRET"
  echo "admins updated"
fi

# Read-only login for Metabase (sees only the analytics schema; sql/20_analytics.sql).
if [[ -n "${METABASE_DB_PASSWORD:-}" ]]; then
  # Metabase's own settings DB (init-databases.sql only runs on a fresh volume)
  psql ${DATABASE_URL:+"$DATABASE_URL"} -X -q -d postgres -tc "select 1 from pg_database where datname = 'metabase'" | grep -q 1 \
    || psql ${DATABASE_URL:+"$DATABASE_URL"} -X -q -d postgres -c "create database metabase"
  cat <<'SQL' | PGOPTIONS="-c client_min_messages=warning" psql ${DATABASE_URL:+"$DATABASE_URL"} -X -q -v ON_ERROR_STOP=1 -o /dev/null -v pw="$METABASE_DB_PASSWORD"
select format(case when exists (select 1 from pg_roles where rolname = 'metabase_ro')
                   then 'alter role metabase_ro login password %L'
                   else 'create role metabase_ro login password %L' end, :'pw') \gexec
grant analytics_ro to metabase_ro;
alter role metabase_ro set search_path = analytics;
SQL
  echo "metabase_ro login ready"
fi

# Approved general-information text for Mela Q&A answers.
if [[ -f data/history.md ]]; then
  echo "insert into svc_mela.qa_context (id, content) values (1, :'content')
        on conflict (id) do update set content = excluded.content;" \
    | psql ${DATABASE_URL:+"$DATABASE_URL"} -X -q -v ON_ERROR_STOP=1 -o /dev/null -v content="$(cat data/history.md)"
  echo "mela Q&A context loaded"
fi

