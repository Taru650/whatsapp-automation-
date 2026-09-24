#!/usr/bin/env bash
# Run the whole stack locally WITHOUT Docker (developer laptop / CI / sandbox):
# a local Postgres, the Graph + Anthropic mocks, and n8n from npm.
#
# Requirements: Node >= 24, Postgres 16 server binaries, Python 3.
#   N8N_BIN      path to the n8n binary (default: npx --yes n8n@$N8N_VERSION)
#   PGHOST/PGPORT/PGUSER/PGPASSWORD   an existing Postgres to use
#   ENV_FILE     env file to load (default tests/test.env -> mocks, ENV=test)
#
#   scripts/dev_up.sh          migrate, start mocks, import workflows, start n8n
#   scripts/dev_up.sh stop     stop mocks and n8n started by this script
set -euo pipefail
cd "$(dirname "$0")/.."
RUN=.dev
mkdir -p "$RUN"
N8N_VERSION=$(node -p "require('./package.json').config.n8nVersion")

stop() {
  for p in n8n graph anthropic; do
    [[ -f "$RUN/$p.pid" ]] && kill "$(cat "$RUN/$p.pid")" 2>/dev/null || true
    rm -f "$RUN/$p.pid"
  done
}
if [[ "${1:-}" == "stop" ]]; then stop; exit 0; fi

set -a; source "${ENV_FILE:-tests/test.env}"; set +a
export PGHOST=${PGHOST:-127.0.0.1} PGPORT=${PGPORT:-5432} PGUSER=${PGUSER:-postgres}
export PGDATABASE=${POSTGRES_DB:-citizen_bot}
export POSTGRES_HOST=$PGHOST POSTGRES_PORT=$PGPORT POSTGRES_USER=$PGUSER POSTGRES_DB=$PGDATABASE
export POSTGRES_PASSWORD=${PGPASSWORD:-postgres}
export N8N_USER_FOLDER=${N8N_USER_FOLDER:-$PWD/$RUN/n8n}
export N8N_BIN=${N8N_BIN:-npx --yes n8n@$N8N_VERSION}

stop
psql -d postgres -Xqtc "select 1 from pg_database where datname='$PGDATABASE'" | grep -q 1 \
  || psql -d postgres -Xqc "create database $PGDATABASE"
scripts/db_migrate.sh

python3 tests/mocks/graph_api.py --port 8081 & echo $! > "$RUN/graph.pid"
python3 tests/mocks/anthropic.py --port 8082 & echo $! > "$RUN/anthropic.pid"

scripts/n8n_import.sh
$N8N_BIN start > "$RUN/n8n.log" 2>&1 & echo $! > "$RUN/n8n.pid"
# /healthz answers before workflows are activated; wait for the router webhook itself
# (404 = not registered yet, 403 = registered and rejecting our dummy token).
for _ in $(seq 1 120); do
  code=$(curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:5678/webhook/wa?hub.mode=subscribe&hub.verify_token=probe' || true)
  [[ "$code" == "403" || "$code" == "200" ]] && { echo "n8n up: http://127.0.0.1:5678"; exit 0; }
  sleep 2
done
echo "n8n did not start; see $RUN/n8n.log" >&2
exit 1
