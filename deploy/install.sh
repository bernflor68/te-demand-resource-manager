#!/usr/bin/env bash
# One-shot installer for a fresh Ubuntu/Debian VPS (Hostinger). Run as root:
#   curl -fsSL https://raw.githubusercontent.com/<USER>/<REPO>/main/deploy/install.sh | \
#     sudo REPO_URL=https://github.com/<USER>/<REPO>.git DOMAIN=app.example.com bash
set -euo pipefail

REPO_URL="${REPO_URL:?Set REPO_URL=https://github.com/<user>/<repo>.git}"
APP_DIR="${APP_DIR:-/opt/te-app}"
BRANCH="${BRANCH:-main}"
DOMAIN="${DOMAIN:-:80}"

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)."; exit 1; }

command -v git >/dev/null || { apt-get update -y && apt-get install -y git; }
command -v docker >/dev/null || { echo ">> Installing Docker"; curl -fsSL https://get.docker.com | sh; }
docker compose version >/dev/null 2>&1 || apt-get install -y docker-compose-plugin

if [ -d "$APP_DIR/.git" ]; then
  echo ">> Updating existing checkout in $APP_DIR"; git -C "$APP_DIR" pull --ff-only
else
  echo ">> Cloning $REPO_URL into $APP_DIR"; git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

if [ ! -f .env ]; then
  ADMIN_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 16)"
  cp .env.example .env
  sed -i "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|" .env
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${ADMIN_PASSWORD}|" .env
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(head -c 36 /dev/urandom | base64 | tr -d '/+=' )|" .env
  [ "$DOMAIN" != ":80" ] && sed -i "s|^APP_URL=.*|APP_URL=https://${DOMAIN}|" .env
  chmod 600 .env
  echo ">> .env created. Initial admin: admin@example.com / ${ADMIN_PASSWORD}  (change it after first login)"
fi

mkdir -p data && chown -R 1000:1000 data
docker compose up -d --build

echo ">> Waiting for the app to become healthy..."
for i in $(seq 1 30); do
  if docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo ">> OK. Open http://${DOMAIN#:80}$( [ "$DOMAIN" = ":80" ] && hostname -I | awk '{print $1}' )"; exit 0; fi
  sleep 2
done
echo "!! App did not become healthy. Check: docker compose logs app"; exit 1
