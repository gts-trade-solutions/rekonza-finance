-- One-time setup for a fresh machine, run as the MySQL root user:
--
--   "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -p -e "source E:/arun/rekonza/db/setup/create-database.sql"
--
-- The app's own user can read and write its database but cannot create one,
-- so this step needs root. Everything after it (npm run db:migrate,
-- npm run db:seed) runs as the app's user.

CREATE DATABASE IF NOT EXISTS rekonza CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON rekonza.* TO 'finora_user'@'localhost';

-- npm run db:protect installs triggers that stop anyone editing or deleting
-- posted journal entries and the audit trail. With binary logging on (the
-- MySQL default), only a SUPER user may create triggers unless this is set.
-- It is server-wide and survives restarts.
SET PERSIST log_bin_trust_function_creators = 1;
