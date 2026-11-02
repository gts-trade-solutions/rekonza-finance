-- Workflow rules in use (services/workflows.ts).
--
-- A rule names an event (invoice.created, bill.created …), conditions on the
-- record (total above ₹5 lakh, the customer in Karnataka) and what to do: tell
-- people in the app, or send an email. The rules table has been here since
-- 007; this adds the runs. A run is queued in the same transaction as the
-- event's audit row, so a rolled-back change never fires a rule, and the
-- scheduler works through the queue: conditions are read against the record
-- as it is then, and the outcome is kept, matched or not.

CREATE TABLE IF NOT EXISTS workflow_runs (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id       BIGINT        NOT NULL,
  rule_id      BIGINT        NOT NULL,
  event        VARCHAR(60)   NOT NULL,
  target_type  VARCHAR(30)   NOT NULL,
  target_id    BIGINT        NOT NULL,
  status       ENUM('queued','done','skipped','failed') NOT NULL DEFAULT 'queued',
  detail       VARCHAR(500)  NULL,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ran_at       TIMESTAMP     NULL,
  CONSTRAINT fk_wfrun_rule FOREIGN KEY (rule_id) REFERENCES workflow_rules(id) ON DELETE CASCADE,
  KEY idx_wfrun_queue (status, id),
  KEY idx_wfrun_rule (org_id, rule_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE workflow_rules
  ADD COLUMN last_run_at TIMESTAMP NULL,
  ADD COLUMN runs INT NOT NULL DEFAULT 0;
