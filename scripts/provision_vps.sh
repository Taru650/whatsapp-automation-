#!/usr/bin/env bash
# Build a fresh Ubuntu 24.04 server (E2E Networks, or any KVM VPS) into a
# running bot + staff portal from the latest backup (plan §2.4). Idempotent:
# safe to re-run.
#
# Run as root on the server:
#   git clone <repo> /opt/citizen-bot && cd /opt/citizen-bot
#   cp /path/to/.env .            # the production .env (same PHONE_HASH_SECRET / PGCRYPTO_KEY!)
#   scp office:/var/backups/citizen-bot/*-<stamp>.* /var/backups/citizen-bot/   (or rclone copy from off-site)
#   BACKUP_PASSPHRASE=... TAILSCALE_AUTHKEY=... scripts/provision_vps.sh [tunnel|vps]
#
#   tunnel (default): reuse the Cloudflare Tunnel token -> no DNS change, nothing changes for Meta
#   vps:              Caddy with Let's Encrypt on ports 80/443 -> point PUBLIC_HOST's DNS at this server
#                     BEFORE running (the certificate is requested on start)
#
# No backup in /var/backups/citizen-bot: a fresh, empty database is set up instead.
# EXECUTIONS_MODE=queue in .env: Redis + N8N_WORKERS workers (default 3) are started too.
set -euo pipefail
cd "$(dirname "$0")/.."
MODE=${1:-tunnel}
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -f .env ]] || { echo ".env missing: copy the production .env here first" >&2; exit 1; }
: "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE}"

step() { echo; echo "== $*"; }

step "packages, automatic security updates, fail2ban"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl git openssl ufw fail2ban unattended-upgrades rclone
dpkg-reconfigure -f noninteractive unattended-upgrades
systemctl enable --now fail2ban

step "docker"
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
systemctl enable --now docker

step "tailscale (admin access; SSH is closed to the internet)"
if ! command -v tailscale >/dev/null; then curl -fsSL https://tailscale.com/install.sh | sh; fi
if [[ -n "${TAILSCALE_AUTHKEY:-}" ]]; then tailscale up --authkey "$TAILSCALE_AUTHKEY" --ssh --hostname citizen-bot-vps; fi

step "firewall"
ufw default deny incoming
ufw default allow outgoing
ufw allow in on tailscale0
if [[ "$MODE" == "vps" ]]; then ufw allow 80/tcp; ufw allow 443/tcp; fi
if tailscale status >/dev/null 2>&1; then
  ufw --force enable
else
  echo "WARNING: tailscale is not up; leaving ufw disabled so you are not locked out of SSH." >&2
fi

step "database"
docker compose up -d postgres
until docker compose exec -T postgres pg_isready -q; do sleep 2; done
if ls "${BACKUP_DIR:-/var/backups/citizen-bot}"/citizen_bot-*.dump.enc >/dev/null 2>&1; then
  echo "restoring the latest backup from ${BACKUP_DIR:-/var/backups/citizen-bot}"
  scripts/restore.sh
else
  echo "no backup found: starting with an empty database"
fi
docker compose run --rm migrate

step "workflows + start (bot, staff portal$(grep -q '^EXECUTIONS_MODE=queue' .env && echo ', queue workers'))"
docker compose run --rm import
profiles=(--profile "$MODE" --profile portal)
scale=()
if grep -q '^EXECUTIONS_MODE=queue' .env; then
  profiles+=(--profile scale)
  scale=(--scale "n8n-worker=${N8N_WORKERS:-3}")
fi
docker compose "${profiles[@]}" up -d --build "${scale[@]}"

step "smoke test"
sleep 15
code=$(docker compose exec -T n8n wget -qO- -S http://localhost:5678/webhook/health 2>&1 | awk '/HTTP\//{print $2}' | tail -1 || true)
echo "health endpoint: HTTP ${code:-?}"
cat <<'MSG'

Next:
  1. STOP the old stack (docker compose --profile portal down on the old machine - never -v),
     so only one bot answers and only one sends complaint updates.
  2. tunnel mode: nothing else. vps mode: Meta callback URL -> https://PUBLIC_HOST/webhook/wa
     (Verify and save) - the DNS A record must already point here.
  3. From a phone, send "hi" to the WhatsApp number; check UptimeRobot is green.
  4. Install the nightly backup cron (see scripts/backup.sh).
MSG
