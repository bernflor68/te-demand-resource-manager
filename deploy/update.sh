#!/usr/bin/env bash
# Pull the latest code from GitHub and rebuild. Run from anywhere on the VPS.
set -euo pipefail
cd "$(dirname "$0")/.."
bash deploy/backup.sh || echo "(backup skipped)"
git pull --ff-only
docker compose up -d --build
docker image prune -f >/dev/null
docker compose ps
