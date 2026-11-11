#!/bin/bash
# Sets up FerTable on a fresh Debian 12 server (run as root):
#   sudo bash setup.sh <domain> [backup-bucket]
# Installs Node.js 22 and Caddy (automatic HTTPS), builds FerTable from GitHub, runs it as a
# systemd service, adds swap for small machines, nightly backups and automatic security updates.
# Safe to run again: it updates what is already there.
set -euo pipefail

DOMAIN="${1:?Usage: setup.sh <domain> [backup-bucket]}"
BUCKET="${2:-}"
REPO="${REPO:-https://github.com/fernandojcardenas/FerTable.git}"
APP=/opt/fertable
DATA=/var/lib/fertable
export DEBIAN_FRONTEND=noninteractive

echo "==> Swap (small machines need it to build)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> System packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git debian-keyring debian-archive-keyring apt-transport-https unattended-upgrades >/dev/null
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null

echo "==> Node.js 22"
if ! node --version 2>/dev/null | grep -q '^v22'; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq && apt-get install -y -qq nodejs >/dev/null
fi

echo "==> Caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

echo "==> FerTable user and code"
id fertable >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin fertable
install -d -o fertable -g fertable -m 0750 "$DATA" "$DATA/db" "$DATA/backups"
install -d -o fertable -g fertable -m 0755 "$APP"
if [ -d "$APP/.git" ]; then
  sudo -u fertable git -C "$APP" pull --ff-only
else
  sudo -u fertable git clone --depth 50 "$REPO" "$APP"
fi

echo "==> Settings (/etc/fertable/fertable.env)"
install -d -m 0750 -g fertable /etc/fertable
if [ ! -f /etc/fertable/fertable.env ]; then
  cat > /etc/fertable/fertable.env <<ENV
NODE_ENV=production
HOST=127.0.0.1
PORT=3210
APP_URL=https://$DOMAIN
FERTABLE_DATA_DIR=$DATA/db
FERTABLE_TRUST_PROXY=true
NEXT_TELEMETRY_DISABLED=1
# Optional: SMTP_URL=smtps://user:pass@smtp.example.com:465
# Optional: ANTHROPIC_API_KEY=...  and  FERTABLE_AI_MODEL=...
ENV
fi
chmod 0640 /etc/fertable/fertable.env && chgrp fertable /etc/fertable/fertable.env

echo "==> Build (a few minutes on a small machine)"
sudo -u fertable bash -c "cd $APP && npm ci --no-audit --no-fund --loglevel=error && NODE_OPTIONS=--max-old-space-size=1536 npm run build >/dev/null"

echo "==> Service"
install -m 0644 "$APP/deploy/gcp/fertable.service" /etc/systemd/system/fertable.service
sed "s/{{DOMAIN}}/$DOMAIN/" "$APP/deploy/gcp/Caddyfile" > /etc/caddy/Caddyfile
install -m 0755 "$APP/deploy/gcp/backup.sh" /usr/local/bin/fertable-backup
install -m 0644 "$APP/deploy/gcp/fertable-backup.service" /etc/systemd/system/fertable-backup.service
install -m 0644 "$APP/deploy/gcp/fertable-backup.timer" /etc/systemd/system/fertable-backup.timer
echo "BUCKET=$BUCKET" > /etc/fertable/backup.env
systemctl daemon-reload
systemctl enable --now fertable >/dev/null
systemctl enable --now fertable-backup.timer >/dev/null
systemctl reload caddy || systemctl restart caddy

echo "==> Waiting for FerTable"
for _ in $(seq 1 60); do curl -fsS -o /dev/null http://127.0.0.1:3210/api/server && break; sleep 2; done
curl -fsS http://127.0.0.1:3210/api/server && echo
echo "Done: https://$DOMAIN"
