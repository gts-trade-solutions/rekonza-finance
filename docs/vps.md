# Rekonza on a VPS

Written for whoever sets up and looks after the server.

The Vercel link only plays a recording of the demo book. A VPS runs the full app: real books in MySQL on the same server, the app's own background worker, daily backups, and TLS.

## What you need first

- **A server:** Ubuntu 22.04 or 24.04, at least 2 GB of memory and 20 GB of disk. Rule 3(5) of the Companies (Accounts) Rules wants the books and their backups on servers in India, so use an Indian region such as Mumbai.
- **SSH access as root**, or as a user with sudo.
- **For https**, a domain name with its DNS A record pointing at the server's IP, and an email address for the free certificate. Without a domain, the app is served over plain http on the IP. The go-live check fails until it is on https.

## First time

On the server:

```
git clone https://github.com/gts-trade-solutions/rekonza-finance.git /opt/rekonza
sudo DOMAIN=books.example.in EMAIL=it@example.in bash /opt/rekonza/deploy/vps/setup.sh
```

The script installs Node 22, MySQL 8, nginx and certbot. It then sets up:

- a database, with a user only it can use;
- `/opt/rekonza/.env.production.local`, with new secrets;
- the migrations and the build;
- the tamper-proof trail;
- a systemd service, the web server and TLS;
- the firewall;
- a daily backup at 1 am and a restore drill on the 1st of each month.

It ends by running the go-live check.

**Copy `BACKUP_KEY` and `FIELD_ENCRYPTION_KEY` from the settings file to a password manager straight away.** Without `BACKUP_KEY`, the backups cannot be restored. If `FIELD_ENCRYPTION_KEY` changes, sealed bank numbers can no longer be read.

`MODE=demo` sets up the recorded demo book instead, like the Vercel link. It has no database and nothing saves.

## Then

- **First company.** Open the site and sign up: the first account becomes the admin of the first company.
- **Email, GST and more.** Add the email (SMTP), GSP, e-invoicing, Razorpay and OpenAI settings to `.env.production.local` when the business has them. See `.env.example`. Then run `sudo systemctl restart rekonza`.
- **Health.** The go-live check, any time: `cd /opt/rekonza && sudo -u rekonza npx tsx --conditions=react-server --env-file=.env.production.local scripts/golive.ts`. Settings → System health shows the same thing in the app.

## Updating

```
sudo bash /opt/rekonza/deploy/vps/update.sh
```

The update script does the following, in order:

1. Takes a backup.
2. Pulls `main`.
3. Runs any new migrations.
4. Builds into the spare build folder. A failed build leaves the running app untouched.
5. Switches to the new build and restarts.

## Looking after it

| What | Command |
| --- | --- |
| App log | `journalctl -u rekonza -f` |
| Restart | `sudo systemctl restart rekonza` |
| Backups | `/opt/rekonza/backups`; the log is `backups/backup.log`, and Settings → Backups shows the newest backup and the last restore drill |
| Copy off the server | Copy the backups to storage outside the server, still in India: `rsync` or `aws s3 sync` the backups folder nightly |
