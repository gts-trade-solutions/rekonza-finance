-- 020_ai_reports.sql
-- The detailed reports the assistant shows under an answer, and who has
-- downloaded which.
--
-- A report is built from the same report functions the answer's figures came
-- from — the model never writes one — and stored with the answer, so opening
-- the conversation later shows the figures as they were when asked.
--
-- A download is recorded once per person, answer and report. A person's first
-- download is free; each new report after that is charged, through ai_usage
-- and the credit ledger like a question. Downloading the same report again,
-- in either format, is free: the row is the receipt.

ALTER TABLE ai_messages
  ADD COLUMN reports_json JSON NULL AFTER sources_json;

-- No foreign key to ai_messages on purpose. Deleting a conversation removes
-- its messages, and the receipts have to outlive them — otherwise deleting a
-- conversation would hand out another free first download.
CREATE TABLE IF NOT EXISTS ai_report_downloads (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id       BIGINT        NOT NULL,
  user_id      BIGINT        NOT NULL,
  message_id   BIGINT        NOT NULL,
  report_key   VARCHAR(120)  NOT NULL,
  -- The format asked for first. The same report again, in either format,
  -- reuses this row.
  format       ENUM('png','csv') NOT NULL,
  charged_mc   BIGINT        NOT NULL DEFAULT 0,
  free         TINYINT(1)    NOT NULL DEFAULT 0,
  usage_id     BIGINT        NULL,
  created_at   DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_ard_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_ard_report (org_id, user_id, message_id, report_key),
  KEY idx_ard_user (org_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
