# Backups and the tamper-proof trail

Written for whoever runs the database in production.

## What the law asks

- **Daily backup in India.** Rule 3(5) of the Companies (Accounts) Rules: books kept electronically are backed up daily, on servers physically in India.
- **Eight years.** Section 128(5) of the Companies Act: books are kept for eight financial years.
- **An edit log that cannot be disabled.** Rule 3(1), and the auditor reports on it under Rule 11(g).

## Taking backups

```
npm run db:backup
```

Each run writes `BACKUP_DIR/<database>-<timestamp>.sql.gz.enc`, the attachments in `BACKUP_DIR/<database>-files-<timestamp>.bin.gz.enc`, and a `.json` manifest with the time taken, the sizes and the SHA-256 of both.

- The dump is a consistent snapshot (`--single-transaction`), so it runs while people work.
- Attachments (bill scans, contracts) live in `FILE_STORAGE_DIR`, not the database, so they are archived beside it.
- Both are gzipped, then encrypted with AES-256-GCM under `BACKUP_KEY`. Without the key they cannot be read.
- Keep `BACKUP_KEY` in a password manager or secrets store, **not** on the backup disk. A lost key means the backups cannot be restored.
- Every run, check and drill is recorded in the `backup_runs` table. **Settings → Backups** shows the age of the newest backup, the last proved restore, and a warning when either is overdue.

## Recovery targets

- **Recovery point (RPO): 24 hours.** Daily backups mean a disaster costs at most a day's entries. For less, add MySQL binary-log shipping to the same Indian region; the daily backup remains the legal copy.
- **Recovery time (RTO): the drill time plus switching over.** Each drill records how long the restore took; Settings shows it.

### Run it every day

Windows Task Scheduler (runs at 1:00 am):

```
schtasks /Create /SC DAILY /ST 01:00 /TN "Rekonza backup" /TR "cmd /c cd /d E:\path\to\app && npm run db:backup >> backups\backup.log 2>&1"
```

Linux cron:

```
0 1 * * * cd /srv/app && npm run db:backup >> backups/backup.log 2>&1
```

Point `BACKUP_DIR` at storage in an Indian region (for example a mounted volume or a synced folder backed by an India-region bucket), and on a different machine from the database.

### Keeping them

Keep every daily backup for at least 35 days, and the first backup of each month for eight years. The script never deletes anything. Pruning is a deliberate job for the operator.

## Proving a backup works

```
npm run db:backup -- verify backups/<file>.sql.gz.enc
```

This checks both files against their manifest, decrypts and decompresses all of them, confirms the dump finished and every attachment is there, and lists any live table missing from it. Run it after each backup.

### The monthly restore drill

Once a month, prove a backup comes back:

```
-- as root, once (the scratch database's name is BACKUP_DRILL_DB, default <database>_restore_check):
CREATE DATABASE rekonza_restore_check;
GRANT ALL PRIVILEGES ON rekonza_restore_check.* TO 'finora_user'@'localhost';
```

```
npm run db:backup -- drill
```

The drill takes the newest backup, empties the scratch database, restores into it, and compares the journal with the live one. Posted entries are never edited or deleted, so every journal line in the copy must still be in the live books unchanged: same count, same debits, same credits. It records the result and the time taken. Schedule it monthly next to the daily backup:

```
schtasks /Create /SC MONTHLY /D 1 /ST 02:00 /TN "Rekonza restore drill" /TR "cmd /c cd /d E:\path\to\app && npm run db:backup -- drill >> backups\backup.log 2>&1"
```

To restore for real, into another database and optionally the attachments into another folder:

```
npm run db:backup -- restore backups/<file>.sql.gz.enc --into rekonza_recovered --files-into storage/files-recovered
```

Restore verifies the whole file before loading anything, and refuses to restore over the live database or the live attachments.

## Making the trail tamper-proof

The application never edits or deletes the audit log or a posted journal entry. `npm run db:protect` makes the database refuse it too, even for someone with a database login. The only exception is the demo company, which can be reset.

MySQL with binary logging on (the default) only allows this for an account with SUPER, or once the server allows it. Run this once as root:

```
SET PERSIST log_bin_trust_function_creators = 1;
```

Then run:

```
npm run db:protect
```

On a managed database (RDS, Cloud SQL), set `log_bin_trust_function_creators` in the parameter group instead. You can also put an administrator account in `DB_PROTECT_USER` / `DB_PROTECT_PASSWORD`.

The Audit trail screen shows **Locked in the database** once the protection is in place.
