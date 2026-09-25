#!/usr/bin/env bash
# Run the whole stack locally WITHOUT Docker (developer laptop / CI / sandbox):
# a local Postgres, the Graph + Anthropic mocks, and n8n from npm.
#
# Requirements: Node >= 24, Postgres 16 server binaries, Python 3.
#   N8N_BIN      path to the n8n binary (default: npx --yes n8n@$N8N_VERSION)
#   PGHOST/PGPORT/PGUSER/PGPASSWORD   an existing Postgres to use
#   ENV_FILE     env file to load (default tests/test.env -> mocks, ENV=test)
#   QUEUE_WORKERS=N  run n8n in queue mode: Redis + main + N workers (n8n data in Postgres)
#
#   scripts/dev_up.sh          migrate, start mocks, import workflows, start n8n
#   scripts/dev_up.sh stop     stop mocks and n8n started by this script
set -euo pipefail
cd "$(dirname "$0")/.."
RUN=.dev
mkdir -p "$RUN"
N8N_VERSION=$(node -p "require('./package.json').config.n8nVersion")

stop() {
  for p in n8n graph anthropic sheets redis $(seq -f 'worker%g' 1 9); do
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
if [[ "${QUEUE_WORKERS:-0}" -gt 0 ]]; then
  export N8N_USER_FOLDER=${N8N_USER_FOLDER:-$PWD/$RUN/n8n-queue}   # separate: shared encryption key
else
  export N8N_USER_FOLDER=${N8N_USER_FOLDER:-$PWD/$RUN/n8n}
fi
export N8N_BIN=${N8N_BIN:-npx --yes n8n@$N8N_VERSION}

stop
psql -d postgres -Xqtc "select 1 from pg_database where datname='$PGDATABASE'" | grep -q 1 \
  || psql -d postgres -Xqc "create database $PGDATABASE"
scripts/db_migrate.sh

python3 tests/mocks/graph_api.py --port 8081 & echo $! > "$RUN/graph.pid"
python3 tests/mocks/anthropic.py --port 8082 & echo $! > "$RUN/anthropic.pid"
python3 tests/mocks/sheets.py --port 8083 & echo $! > "$RUN/sheets.pid"

# Throwaway Google service-account key for the Sheets mock (tests only).
if [[ -z "${GOOGLE_SA_JSON:-}" && "${ENV:-}" == "test" ]]; then
  [[ -f "$RUN/test_sa.pem" ]] || openssl genrsa -out "$RUN/test_sa.pem" 2048 2>/dev/null
  export GOOGLE_SA_JSON=$(python3 -c "import json,sys; print(json.dumps({'type':'service_account','client_email':'bot@test.iam.gserviceaccount.com','private_key':open(sys.argv[1]).read(),'token_uri':'http://127.0.0.1:8083/token'}))" "$RUN/test_sa.pem")
fi

if [[ "${QUEUE_WORKERS:-0}" -gt 0 ]]; then
  # Queue mode needs n8n's own data in Postgres and a shared encryption key.
  psql -d postgres -Xqtc "select 1 from pg_database where datname='n8n'" | grep -q 1 || psql -d postgres -Xqc "create database n8n"
  export DB_TYPE=postgresdb DB_POSTGRESDB_HOST=$PGHOST DB_POSTGRESDB_PORT=$PGPORT DB_POSTGRESDB_DATABASE=n8n
  export DB_POSTGRESDB_USER=$PGUSER DB_POSTGRESDB_PASSWORD=$POSTGRES_PASSWORD
  export EXECUTIONS_MODE=queue QUEUE_BULL_REDIS_HOST=127.0.0.1 QUEUE_BULL_REDIS_PORT=${REDIS_PORT:-6379}
  export N8N_ENCRYPTION_KEY=${N8N_ENCRYPTION_KEY:-dev-only-encryption-key}
  redis-server --port "${REDIS_PORT:-6379}" --save '' --appendonly no > "$RUN/redis.log" 2>&1 & echo $! > "$RUN/redis.pid"
fi

scripts/n8n_import.sh
$N8N_BIN start > "$RUN/n8n.log" 2>&1 & echo $! > "$RUN/n8n.pid"
for i in $(seq 1 "${QUEUE_WORKERS:-0}"); do
  N8N_RUNNERS_BROKER_PORT=$((5679 + i)) QUEUE_HEALTH_CHECK_PORT=$((5690 + i)) \
    $N8N_BIN worker --concurrency=10 > "$RUN/worker$i.log" 2>&1 & echo $! > "$RUN/worker$i.pid"
done
# /healthz answers before workflows are activated; wait for the router webhook itself
# (404 = not registered yet, 403 = registered and rejecting our dummy token).
for _ in $(seq 1 120); do
  code=$(curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:5678/webhook/wa?hub.mode=subscribe&hub.verify_token=probe' || true)
  [[ "$code" == "403" || "$code" == "200" ]] && { echo "n8n up: http://127.0.0.1:5678"; exit 0; }
  sleep 2
done
echo "n8n did not start; see $RUN/n8n.log" >&2
exit 1
