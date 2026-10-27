-- Scheduled reports, and the in-app notifications that say they are ready.
--
-- There is no mail transport, so a scheduled report is made into a workbook,
-- kept, and announced to its recipients under the bell; a webhook can carry
-- the news to other software. Recipients are checked against the report's
-- group when it runs, so a role that loses a report stops receiving it.

CREATE TABLE IF NOT EXISTS notifications (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id      BIGINT       NOT NULL,
  user_id     BIGINT       NOT NULL,
  kind        VARCHAR(40)  NOT NULL,
  title       VARCHAR(200) NOT NULL,
  body        VARCHAR(500) NULL,
  href        VARCHAR(300) NULL,
  read_at     TIMESTAMP    NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ntf_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  KEY idx_ntf_user (user_id, read_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS report_schedules (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT       NOT NULL,
  name                VARCHAR(100) NOT NULL,
  report              VARCHAR(40)  NOT NULL,
  period              VARCHAR(20)  NOT NULL,
  frequency           ENUM('daily','weekly','monthly') NOT NULL,
  next_run            DATE         NOT NULL,
  recipients          JSON         NOT NULL,
  is_active           TINYINT(1)   NOT NULL DEFAULT 1,
  last_run_at         TIMESTAMP    NULL,
  last_error          VARCHAR(500) NULL,
  created_by_user_id  BIGINT       NULL,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_rsch_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  KEY idx_rsch_due (is_active, next_run)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS report_files (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id        BIGINT       NOT NULL,
  schedule_id   BIGINT       NULL,
  report        VARCHAR(40)  NOT NULL,
  name          VARCHAR(200) NOT NULL,
  period_from   DATE         NULL,
  period_to     DATE         NOT NULL,
  storage_key   VARCHAR(200) NOT NULL,
  byte_size     INT          NOT NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_rfile_sched FOREIGN KEY (schedule_id) REFERENCES report_schedules(id) ON DELETE SET NULL,
  KEY idx_rfile_org (org_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
