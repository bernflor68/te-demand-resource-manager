#!/usr/bin/env bash
# Backup database + uploads into ./backups (keeps the last 14 archives). Cron example (daily 02:30):
#   30 2 * * * bash /opt/te-app/deploy/backup.sh >> /var/log/te-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
docker compose exec -T app node server/backup.js
tar czf "backups/te-$(date +%F).tar.gz" -C data backups uploads 2>/dev/null || tar czf "backups/te-$(date +%F).tar.gz" -C data backups
ls -1t backups/te-*.tar.gz | tail -n +15 | xargs -r rm --
echo "Archive: backups/te-$(date +%F).tar.gz"
