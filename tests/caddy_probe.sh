#!/usr/bin/env bash
# Ingress test: run deploy/Caddyfile in front of the local n8n (dev_up.sh) and
# prove only the webhook + health paths get through - no path-traversal or
# encoding trick reaches the test harness or the n8n editor/API - and that
# oversized bodies are refused.   CADDY=/path/to/caddy tests/caddy_probe.sh
set -euo pipefail
cd "$(dirname "$0")/.."
CADDY=${CADDY:-caddy}
PORT=${PROBE_PORT:-8090}
tmp=$(mktemp -d)
sed 's/n8n:5678/127.0.0.1:5678/' deploy/Caddyfile > "$tmp/Caddyfile"
SITE_ADDRESS=":$PORT" "$CADDY" validate --config "$tmp/Caddyfile" --adapter caddyfile >/dev/null 2>&1
SITE_ADDRESS=":$PORT" "$CADDY" run --config "$tmp/Caddyfile" --adapter caddyfile >"$tmp/caddy.log" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null; rm -rf "$tmp"' EXIT
for _ in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$PORT/healthz" && break; sleep 0.5; done

fail=0
check() {  # expected method path [extra curl args...]
  local want=$1 method=$2 path=$3; shift 3
  local got
  got=$(curl -s --path-as-is -o /dev/null -w '%{http_code}' -X "$method" "http://127.0.0.1:$PORT$path" "$@")
  if [[ "$got" == "$want" ]]; then echo "ok   $method $path -> $got"; else echo "FAIL $method $path -> $got (want $want)"; fail=1; fi
}
check 200 GET  /webhook/health
check 200 GET  /healthz
check 200 POST /webhook/wa -H 'Content-Type: application/json' -d '{"object":"whatsapp_business_account"}'
check 403 GET  '/webhook/wa?hub.mode=subscribe&hub.verify_token=wrong'
for p in /webhook/test/service /webhook/wa/../test/service /webhook/wa/%2e%2e/test/service \
         '/webhook/wa%2f..%2ftest%2fservice' //webhook/test/service /webhook//test/service \
         /webhook-test/wa /rest/login /rest/workflows /api/v1/workflows / /signin /webhook/wa/x; do
  check 404 POST "$p" -d '{}'
done
head -c 300000 /dev/zero | tr '\0' a > "$tmp/big"
check 413 POST /webhook/wa --data-binary @"$tmp/big"
exit $fail
