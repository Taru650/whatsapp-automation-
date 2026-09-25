#!/usr/bin/env bash
# Build a fresh Ubuntu 24.04 VPS (Hostinger KVM or similar) into a running bot
# from the latest backup (plan §2.4). Idempotent: safe to re-run.
#
# Run as root on the VPS:
#   git clone <repo> /opt/citizen-bot && cd /opt/citizen-bot
#   cp /path/to/.env .            # the production .env from the password safe
#   scp office:/var/backups/citizen-bot/*-<stamp>.* /var/backups/citizen-bot/   (or rclone copy from off-site)
#   BACKUP_PASSPHRASE=... TAILSCALE_AUTHKEY=... scripts/provision_vps.sh [tunnel|vps]
#
#   tunnel (default): reuse the Cloudflare Tunnel token -> no DNS change, nothing changes for Meta
#   vps:              Caddy with Let's Encrypt on ports 80/443 -> point PUBLIC_HOST's DNS at this server
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

step "database from the latest backup"
docker compose up -d postgres
until docker compose exec -T postgres pg_isready -q; do sleep 2; done
scripts/restore.sh
docker compose run --rm migrate

step "workflows + start"
docker compose run --rm import
docker compose --profile "$MODE" up -d

step "smoke test"
sleep 15
code=$(docker compose exec -T n8n wget -qO- -S http://localhost:5678/webhook/health 2>&1 | awk '/HTTP\//{print $2}' | tail -1 || true)
echo "health endpoint: HTTP ${code:-?}"
cat <<'MSG'

Next:
  1. STOP the office stack (docker compose down on the office machine), so only one bot answers.
  2. tunnel mode: nothing else. vps mode: point PUBLIC_HOST's DNS A record at this server.
  3. From a phone, send "hi" to the WhatsApp number; check UptimeRobot is green.
  4. Install the nightly backup cron (see scripts/backup.sh).
MSG
