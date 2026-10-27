-- A record of every backup, check and restore drill.
--
-- Rule 3(5) of the Companies (Accounts) Rules wants a backup every day, and a
-- backup nobody has restored is a hope rather than a backup. The backup script
-- writes a row here for each run, so the app can say how old the newest backup
-- is (the most data a disaster could cost) and when a restore was last proved
-- to work, instead of somebody having to look in a folder on another machine.
--
-- Not per organisation: one database, one backup.

CREATE TABLE IF NOT EXISTS backup_runs (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  kind          ENUM('backup','verify','drill') NOT NULL,
  started_at    TIMESTAMP(3)  NOT NULL,
  finished_at   TIMESTAMP(3)  NULL,
  ok            TINYINT(1)    NOT NULL DEFAULT 0,
  file          VARCHAR(255)  NULL,
  bytes         BIGINT        NULL,
  sha256        CHAR(64)      NULL,
  files_count   INT           NULL,
  detail        VARCHAR(1000) NULL,
  host          VARCHAR(120)  NULL,
  KEY idx_br_kind_time (kind, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
