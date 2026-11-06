#!/usr/bin/env bash
# Bring Rekonza on this server up to the latest code: run as root (or sudo).
#
#   sudo bash /opt/rekonza/deploy/vps/update.sh
#
# Takes a backup first (live mode), pulls, installs, runs any new migrations,
# builds, re-applies the tamper-proof trail, and restarts. If the build fails,
# the running app is left as it was.
set -euo pipefail
APP_USER=rekonza
APP_DIR=/opt/rekonza
ENV_FILE="$APP_DIR/.env.production.local"
BRANCH="${BRANCH:-main}"
as_app() { sudo -u "$APP_USER" -H bash -lc "cd '$APP_DIR' && $*"; }
live=1; grep -q '^DEMO_SNAPSHOT=1' "$ENV_FILE" && live=0

if [ "$live" = 1 ]; then
  echo "== Backup before the update"
  as_app "node --env-file=$ENV_FILE scripts/db-backup.mjs"
fi
echo "== Code"
as_app "git fetch origin $BRANCH && git checkout $BRANCH && git pull --ff-only origin $BRANCH"
as_app "npm ci --no-audit --no-fund"
if [ "$live" = 1 ]; then
  echo "== Migrations"
  as_app "node --env-file=$ENV_FILE scripts/migrate.mjs"
fi
echo "== Build into the spare folder, so a failed build leaves the app running"
current=$(sed -n 's/^NEXT_BUILD_DIR=//p' "$APP_DIR/.build-dir" 2>/dev/null || true)
next=.next-a; [ "$current" = .next-a ] && next=.next-b
as_app "rm -rf $next && NEXT_BUILD_DIR=$next npx next build"
as_app "echo NEXT_BUILD_DIR=$next > .build-dir"
if [ "$live" = 1 ]; then
  as_app "node --env-file=$ENV_FILE scripts/db-protect.mjs"
fi
systemctl restart rekonza
for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:3000/login && break; sleep 2; done
curl -fsS -o /dev/null -w "login page: %{http_code}\n" http://127.0.0.1:3000/login
as_app "git log -1 --format='Running %h %s'"
