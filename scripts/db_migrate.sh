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

