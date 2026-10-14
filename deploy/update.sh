#!/usr/bin/env bash
# Install a new version uploaded as /tmp/eventpass.tar.gz, keeping .env and all data.
#   sudo bash /opt/eventpass/deploy/update.sh
set -euo pipefail
APP=/opt/eventpass
PKG=${1:-/tmp/eventpass.tar.gz}

[ -f "$PKG" ] || { echo "Upload the new version to $PKG first"; exit 1; }

echo "1/4 Backing up the database..."
sudo -u eventpass bash -c "cd $APP && npm run --silent backup"

echo "2/4 Unpacking new code (keeping .env)..."
cp "$APP/.env" /tmp/eventpass.env.keep
tar -xzf "$PKG" -C "$APP"
mv /tmp/eventpass.env.keep "$APP/.env"
chown -R eventpass:eventpass "$APP"
chmod 600 "$APP/.env"

echo "3/4 Installing dependencies..."
sudo -u eventpass bash -c "cd $APP && npm ci --omit=dev --no-audit --no-fund"

echo "4/4 Restarting..."
systemctl restart eventpass
sleep 2
if curl -fsS http://127.0.0.1:3000/healthz >/dev/null; then
  echo "Updated and running."
else
  echo "App did not come back up - check: journalctl -u eventpass -n 50"
  exit 1
fi
