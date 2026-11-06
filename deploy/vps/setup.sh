#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Rekonza on a VPS, set up from nothing: Ubuntu 22.04 or 24.04, run as root
# (or with sudo) on the server itself.
#
#   DOMAIN=books.example.in EMAIL=it@example.in bash setup.sh
#
#   DOMAIN   the address it is served at; its DNS A record must already point
#            here. Without it the app is served over plain http on the IP.
#   EMAIL    for the free TLS certificate (Let's Encrypt). Needed with DOMAIN.
#   MODE     live (the default): real books in MySQL on this server.
#            demo: the recorded demo book, like the Vercel link; no database.
#   BRANCH   the git branch to deploy. Default main.
#
# What it does, in order: the packages (Node 22, MySQL 8, nginx, certbot), a
# user that runs the app, the code, the database and its user, the settings
# with new secrets, the migrations, the build, the tamper-proof trail, the
# service, the web server, TLS, the firewall, and the daily backup. Run again
# it skips what is already there, and never replaces the settings file.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"
MODE="${MODE:-live}"
BRANCH="${BRANCH:-main}"
REPO="${REPO:-https://github.com/gts-trade-solutions/rekonza-finance.git}"
APP_USER=rekonza
APP_DIR=/opt/rekonza
ENV_FILE="$APP_DIR/.env.production.local"
PORT=3000
DB_NAME=rekonza
DB_USER=rekonza

say() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
# Everything in the app's folder runs as the app's own user (git refuses a
# folder owned by someone else, and the build must not leave root's files).
as_app() { sudo -u "$APP_USER" -H bash -lc "cd '$APP_DIR' && $*"; }
[ "$(id -u)" = 0 ] || { echo "Run as root: sudo bash setup.sh"; exit 1; }
[ "$MODE" = live ] || [ "$MODE" = demo ] || { echo "MODE is live or demo."; exit 1; }
[ -z "$DOMAIN" ] || [ -n "$EMAIL" ] || { echo "Give EMAIL with DOMAIN, for the TLS certificate."; exit 1; }

say "Memory for the build"
# Building the app wants more than 2 GB at its peak: a small server gets swap.
if [ "$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)" -lt 3500 ] && [ -z "$(swapon --show --noheadings)" ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git gnupg nginx ufw openssl
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v
if [ "$MODE" = live ]; then
  apt-get install -y mysql-server
  # The tamper-proof trail is made of triggers; with binary logging on (the
  # default), MySQL lets an ordinary account create them only with this set.
  cat > /etc/mysql/mysql.conf.d/rekonza.cnf <<'CNF'
[mysqld]
log_bin_trust_function_creators = 1
bind-address = 127.0.0.1
mysqlx = OFF
CNF
  systemctl enable --now mysql
  systemctl restart mysql
fi
[ -n "$DOMAIN" ] && apt-get install -y certbot python3-certbot-nginx

say "The user that runs the app"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "/home/$APP_USER" --shell /bin/bash "$APP_USER"

say "The code"
[ -d "$APP_DIR/.git" ] || git clone --branch "$BRANCH" "$REPO" "$APP_DIR"
mkdir -p "$APP_DIR/storage/files" "$APP_DIR/backups"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
as_app "git fetch origin $BRANCH && git checkout $BRANCH && git pull --ff-only origin $BRANCH"

if [ ! -f "$ENV_FILE" ]; then
  say "The settings, with new secrets"
  SITE="http://$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')"
  [ -n "$DOMAIN" ] && SITE="https://$DOMAIN"
  if [ "$MODE" = live ]; then
    DB_PASSWORD="$(openssl rand -hex 24)"
    mysql -e "CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
      CREATE DATABASE IF NOT EXISTS \`${DB_NAME}_restore_check\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
      CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
      ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
      GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
      GRANT ALL PRIVILEGES ON \`${DB_NAME}_restore_check\`.* TO '$DB_USER'@'localhost';
      FLUSH PRIVILEGES;"
    cat > "$ENV_FILE" <<ENV
# Rekonza on this server. Made by deploy/vps/setup.sh on $(date -I).
APP_ENV=production
NEXT_PUBLIC_SITE_URL=$SITE
TRUSTED_PROXY_HOPS=1
DEMO_SNAPSHOT=0

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
DB_NAME=$DB_NAME

# Seals bank numbers, PAN, Aadhaar and two-step secrets. Never change it once
# real data is in; keep a copy in the password manager.
FIELD_ENCRYPTION_KEY=$(openssl rand -hex 32)
# Only for /api/cron/sweep; the app's own worker does the background work here.
CRON_SECRET=$(openssl rand -hex 32)

FILE_STORAGE_DIR=$APP_DIR/storage/files
BACKUP_DIR=$APP_DIR/backups
# Without this key the backups cannot be restored. Copy it to the password
# manager now; do not keep it only on this server.
BACKUP_KEY=$(openssl rand -base64 32)
BACKUP_HOST_NAME=$(hostname)

# Fill these in when the business has them (see .env.example):
# SMTP_HOST= SMTP_PORT=587 SMTP_USER= SMTP_PASSWORD= MAIL_FROM=
# OPENAI_API_KEY=
# GST_API_* (the GSP), NIC_EINV_* (e-invoicing), RAZORPAY_*
ENV
  else
    cat > "$ENV_FILE" <<ENV
# Rekonza on this server: the recorded demo book, nothing saves.
DEMO_SNAPSHOT=1
NEXT_PUBLIC_SITE_URL=$SITE
TRUSTED_PROXY_HOPS=1
JOBS_WORKER=off
ENV
  fi
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
else
  echo "Keeping the settings already in $ENV_FILE."
fi

say "Install, migrate, build"
as_app "npm ci --no-audit --no-fund"
if [ "$MODE" = live ]; then
  as_app "node --env-file=$ENV_FILE scripts/migrate.mjs"
fi
# Two build folders: the live one, and the one the next update builds into.
as_app "NEXT_BUILD_DIR=.next-a npx next build && echo NEXT_BUILD_DIR=.next-a > .build-dir"
if [ "$MODE" = live ]; then
  # The trail: journal lines and the audit log refuse edits and deletes.
  as_app "node --env-file=$ENV_FILE scripts/db-protect.mjs"
fi

say "The service"
sed -e "s#@APP_DIR@#$APP_DIR#g" -e "s#@APP_USER@#$APP_USER#g" -e "s#@PORT@#$PORT#g" \
  "$APP_DIR/deploy/vps/rekonza.service" > /etc/systemd/system/rekonza.service
systemctl daemon-reload
systemctl enable rekonza
systemctl restart rekonza

say "The web server"
SERVER_NAME="${DOMAIN:-_}"
sed -e "s#@SERVER_NAME@#$SERVER_NAME#g" -e "s#@PORT@#$PORT#g" \
  "$APP_DIR/deploy/vps/nginx-rekonza.conf" > /etc/nginx/sites-available/rekonza
ln -sf /etc/nginx/sites-available/rekonza /etc/nginx/sites-enabled/rekonza
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null

if [ -n "$DOMAIN" ]; then
  say "TLS for $DOMAIN"
  certbot --nginx --non-interactive --agree-tos --redirect -m "$EMAIL" -d "$DOMAIN"
fi

if [ "$MODE" = live ]; then
  say "The daily backup, and a monthly restore drill"
  # Rule 3(5), Companies (Accounts) Rules: a daily backup, on servers in India.
  cat > /etc/cron.d/rekonza <<CRON
SHELL=/bin/bash
0 1 * * * $APP_USER cd $APP_DIR && node --env-file=$ENV_FILE scripts/db-backup.mjs >> $APP_DIR/backups/backup.log 2>&1
30 2 1 * * $APP_USER cd $APP_DIR && node --env-file=$ENV_FILE scripts/db-backup.mjs drill >> $APP_DIR/backups/backup.log 2>&1
CRON
  chmod 644 /etc/cron.d/rekonza
  as_app "node --env-file=$ENV_FILE scripts/db-backup.mjs" || echo "The first backup did not run; see above."
fi

say "Is it up?"
for i in $(seq 1 30); do curl -fsS -o /dev/null "http://127.0.0.1:$PORT/login" && break; sleep 2; done
curl -fsS -o /dev/null -w "login page: %{http_code}\n" "http://127.0.0.1:$PORT/login"
if [ "$MODE" = live ]; then
  as_app "npx tsx --conditions=react-server --env-file=$ENV_FILE scripts/golive.ts" || true
  echo
  echo "Copy BACKUP_KEY and FIELD_ENCRYPTION_KEY from $ENV_FILE to a password manager now."
fi
if [ -n "$DOMAIN" ]; then echo "Rekonza is served at https://$DOMAIN"; else echo "Rekonza is served at http://<this server IP>"; fi
