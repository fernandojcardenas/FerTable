#!/bin/bash
# Updates FerTable on the server to the latest code on GitHub (run as root): sudo bash update.sh
set -euo pipefail
APP=/opt/fertable
sudo -u fertable git -C "$APP" pull --ff-only
sudo -u fertable bash -c "cd $APP && npm ci --no-audit --no-fund --loglevel=error && NODE_OPTIONS=--max-old-space-size=1536 npm run build >/dev/null"
install -m 0644 "$APP/deploy/gcp/fertable.service" /etc/systemd/system/fertable.service
systemctl daemon-reload
systemctl restart fertable
for _ in $(seq 1 60); do curl -fsS -o /dev/null http://127.0.0.1:3210/api/server && break; sleep 2; done
curl -fsS http://127.0.0.1:3210/api/server && echo
