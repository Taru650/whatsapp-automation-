#!/usr/bin/env bash
# Ingress test: run deploy/Caddyfile in front of the local n8n (dev_up.sh) and the
# staff portal, and prove only the webhook + health paths and /portal get through -
# no path-traversal or encoding trick reaches the test harness or the n8n
# editor/API - that oversized bodies are refused, and that the portal behind
# Caddy gets the real client (Secure cookie over https, per-client sign-in limit).
#   CADDY=/path/to/caddy tests/caddy_probe.sh
# The portal is started here with production settings (needs portal/node_modules,
# PORTAL_DB_PASSWORD for portal_rw, and PG* env for the cleanup).
set -euo pipefail
cd "$(dirname "$0")/.."
CADDY=${CADDY:-caddy}
PORT=${PROBE_PORT:-8090}
PORTAL_PORT=${PROBE_PORTAL_PORT:-3901}
tmp=$(mktemp -d)
probe_user="probe.$$"
probe_pw="probe-password-$RANDOM-$RANDOM"
pids=()
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  psql -X -q -v ON_ERROR_STOP=0 -c "
    delete from grievance.portal_sessions where (sess->>'userId')::bigint in (select user_id from grievance.portal_users where username = '$probe_user');
    delete from grievance.portal_audit where user_id in (select user_id from grievance.portal_users where username = '$probe_user');
    delete from grievance.portal_users where username = '$probe_user';" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

# --- the portal, as production runs it (ENV=prod: real secret, auto-Secure cookie, trusts one proxy)
export ENV=prod PORTAL_PORT PORTAL_DB_HOST=${PGHOST:-127.0.0.1} PORTAL_DB_PORT=${PGPORT:-5432}
export PORTAL_DB_PASSWORD=${PORTAL_DB_PASSWORD:?set PORTAL_DB_PASSWORD (portal_rw)} PORTAL_SESSION_SECRET=$(openssl rand -hex 32)
export PORTAL_BCRYPT_ROUNDS=4 PORTAL_TRUST_PROXY=1 PORTAL_LOGIN_LIMIT=5 COMPLAINT_MEDIA_PATH="$tmp/media"
mkdir -p "$tmp/media"
printf '%s\n' "$probe_pw" | node portal/scripts/create_user.mjs --role district_admin --username "$probe_user" --name "Caddy probe" >/dev/null
node portal/src/server.js >"$tmp/portal.log" 2>&1 &
pids+=($!)

sed -e 's/n8n:5678/127.0.0.1:5678/' -e "s/portal:3001/127.0.0.1:$PORTAL_PORT/" deploy/Caddyfile > "$tmp/Caddyfile"
SITE_ADDRESS=":$PORT" "$CADDY" validate --config "$tmp/Caddyfile" --adapter caddyfile >/dev/null 2>&1
SITE_ADDRESS=":$PORT" "$CADDY" run --config "$tmp/Caddyfile" --adapter caddyfile >"$tmp/caddy.log" 2>&1 &
pids+=($!)
for _ in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$PORT/healthz" && break; sleep 0.5; done
for _ in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$PORTAL_PORT/portal/healthz" && break; sleep 0.5; done

fail=0
ok()  { echo "ok   $*"; }
bad() { echo "FAIL $*"; fail=1; }
check() {  # expected method path [extra curl args...]
  local want=$1 method=$2 path=$3; shift 3
  local got
  got=$(curl -s --path-as-is -o /dev/null -w '%{http_code}' -X "$method" "http://127.0.0.1:$PORT$path" "$@")
  if [[ "$got" == "$want" ]]; then ok "$method $path -> $got"; else bad "$method $path -> $got (want $want)"; fi
}
# answered by the portal itself (its CSP header), never by n8n or Caddy's 404
from_portal() {  # method path [extra curl args...]
  local method=$1 path=$2; shift 2
  local code
  code=$(curl -s --path-as-is -D "$tmp/h" -o /dev/null -w '%{http_code}' -X "$method" "http://127.0.0.1:$PORT$path" "$@")
  if grep -qi "^content-security-policy:.*script-src 'self'" "$tmp/h" && [[ "$code" != 413 ]]; then
    ok "$method $path -> $code from the portal"
  else
    bad "$method $path -> $code, not answered by the portal"
  fi
}

# --- n8n: unchanged allowlist
check 200 GET  /webhook/health
check 200 GET  /healthz
check 200 POST /webhook/wa -H 'Content-Type: application/json' -d '{"object":"whatsapp_business_account"}'
check 403 GET  '/webhook/wa?hub.mode=subscribe&hub.verify_token=wrong'
for p in /webhook/test/service /webhook/wa/../test/service /webhook/wa/%2e%2e/test/service \
         '/webhook/wa%2f..%2ftest%2fservice' //webhook/test/service /webhook//test/service \
         /webhook-test/wa /rest/login /rest/workflows /api/v1/workflows / /signin /webhook/wa/x \
         /portalx /portal../webhook/test/service /portal-admin; do
  check 404 POST "$p" -d '{}'
done
head -c 300000 /dev/zero | tr '\0' a > "$tmp/big"
check 413 POST /webhook/wa --data-binary @"$tmp/big"

# --- portal: reachable; ".." tricks are cleaned by Caddy before matching, so they
# fall to the 404 catch-all instead of reaching n8n (or the portal)
check 302 GET /portal
check 200 GET /portal/login
check 200 GET /portal/healthz
for p in /portal/../webhook/test/service /portal/%2e%2e/webhook/test/service '/portal/..%2fwebhook%2ftest%2fservice' \
         /portal/../rest/login; do
  check 404 POST "$p" -d '{}'
done
from_portal POST /portal//webhook/test/service -d '{}'

# --- sign-in through Caddy as Cloudflare delivers it (https, CF-Connecting-IP)
cf=(-H "X-Forwarded-Proto: https")   # + -H "CF-Connecting-IP: <ip>" per call
login_page() {  # client-ip -> prints "cookie csrf"
  curl -s -D "$tmp/lh" "${cf[@]}" -H "CF-Connecting-IP: $1" "http://127.0.0.1:$PORT/portal/login" > "$tmp/lb"
  local cookie csrf
  cookie=$(grep -i '^set-cookie:' "$tmp/lh" | head -1 | sed 's/^[Ss]et-[Cc]ookie: //; s/;.*//')
  csrf=$(grep -o 'name="_csrf" value="[a-f0-9]*"' "$tmp/lb" | sed 's/.*value="//; s/"//')
  echo "$cookie $csrf"
}
read -r cookie csrf < <(login_page 203.0.113.7)
if grep -qi '^set-cookie:.*; *secure' "$tmp/lh"; then ok "session cookie is Secure over https"; else bad "session cookie not Secure over https: $(grep -i '^set-cookie' "$tmp/lh")"; fi
code=$(curl -s -D "$tmp/ph" -o /dev/null -w '%{http_code}' "${cf[@]}" -H "CF-Connecting-IP: 203.0.113.7" -H "Cookie: $cookie" \
  --data-urlencode "_csrf=$csrf" --data-urlencode "username=$probe_user" --data-urlencode "password=$probe_pw" "http://127.0.0.1:$PORT/portal/login")
session=$(grep -i '^set-cookie:' "$tmp/ph" | head -1 | sed 's/^[Ss]et-[Cc]ookie: //; s/;.*//')
dash=$(curl -s -o /dev/null -w '%{http_code}' "${cf[@]}" -H "CF-Connecting-IP: 203.0.113.7" -H "Cookie: $session" "http://127.0.0.1:$PORT/portal/")
if [[ "$code" == 302 && "$dash" == 200 ]]; then ok "sign-in through Caddy over https -> dashboard"; else bad "sign-in through Caddy: login $code, dashboard $dash"; fi
grep -qi '^strict-transport-security:' "$tmp/ph" && ok "HSTS on the portal" || bad "no HSTS header"

# body cap, signed in (the portal only reads an upload body for a signed-in user):
# 5 photos of 9 MB (45 MB) must pass Caddy's 55 MB cap and be read by the portal
# (here: 403, no CSRF token - after multer has read every byte); a 60 MB file is refused
for i in 1 2 3 4 5; do { printf '\xff\xd8\xff'; head -c 9000000 /dev/urandom; } > "$tmp/p$i.jpg"; done
code=$(curl -s -D "$tmp/h" -o /dev/null -w '%{http_code}' "${cf[@]}" -H "CF-Connecting-IP: 203.0.113.7" -H "Cookie: $session" \
  -F "photos=@$tmp/p1.jpg" -F "photos=@$tmp/p2.jpg" -F "photos=@$tmp/p3.jpg" -F "photos=@$tmp/p4.jpg" -F "photos=@$tmp/p5.jpg" \
  "http://127.0.0.1:$PORT/portal/complaints/SCB-2026-C00001/close")
if [[ "$code" == 403 ]] && grep -qi "^content-security-policy:.*script-src 'self'" "$tmp/h"; then ok "45 MB of closure photos pass Caddy to the portal"; else bad "45 MB of closure photos -> $code"; fi
head -c 60000000 /dev/zero > "$tmp/60mb.jpg"
code=$(curl -s -o /dev/null -w '%{http_code}' "${cf[@]}" -H "CF-Connecting-IP: 203.0.113.7" -H "Cookie: $session" \
  -F "photos=@$tmp/60mb.jpg" "http://127.0.0.1:$PORT/portal/complaints/SCB-2026-C00001/close")
[[ "$code" == 400 || "$code" == 403 || "$code" == 413 ]] && ok "60 MB upload refused -> $code" || bad "60 MB upload -> $code"

# per-client limit: 5 wrong passwords from one client lock that client out, not everyone
for i in 1 2 3 4 5 6; do
  read -r cookie csrf < <(login_page 203.0.113.50)
  code=$(curl -s -o /dev/null -w '%{http_code}' "${cf[@]}" -H "CF-Connecting-IP: 203.0.113.50" -H "Cookie: $cookie" \
    --data-urlencode "_csrf=$csrf" --data-urlencode "username=$probe_user" --data-urlencode "password=wrong-$i" "http://127.0.0.1:$PORT/portal/login")
done
[[ "$code" == 429 ]] && ok "6th wrong password from one client -> 429" || bad "6th wrong password -> $code (want 429)"
read -r cookie csrf < <(login_page 198.51.100.9)
code=$(curl -s -o /dev/null -w '%{http_code}' "${cf[@]}" -H "CF-Connecting-IP: 198.51.100.9" -H "Cookie: $cookie" \
  --data-urlencode "_csrf=$csrf" --data-urlencode "username=$probe_user" --data-urlencode "password=wrong-again" "http://127.0.0.1:$PORT/portal/login")
[[ "$code" == 401 ]] && ok "another client is not locked out -> 401" || bad "another client -> $code (want 401: the portal must see each client's own IP)"

exit $fail
