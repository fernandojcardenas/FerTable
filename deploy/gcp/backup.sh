#!/bin/bash
# Nightly backup: stops FerTable for a few seconds so the database files are consistent,
# archives them, starts it again, keeps 7 local copies and uploads to Cloud Storage if set.
set -euo pipefail
source /etc/fertable/backup.env
DATA=/var/lib/fertable
STAMP=$(date -u +%Y-%m-%dT%H%M%SZ)
FILE="$DATA/backups/fertable-$STAMP.tar.gz"
systemctl stop fertable
trap 'systemctl start fertable' EXIT
tar -C "$DATA" -czf "$FILE" db
systemctl start fertable
trap - EXIT
chown fertable:fertable "$FILE" && chmod 0600 "$FILE"
ls -1t "$DATA"/backups/fertable-*.tar.gz | tail -n +8 | xargs -r rm -f
if [ -n "${BUCKET:-}" ]; then gcloud storage cp --quiet "$FILE" "gs://$BUCKET/" ; fi
echo "Backup saved: $FILE"
