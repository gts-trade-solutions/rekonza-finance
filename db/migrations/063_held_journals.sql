-- Journals held out of the books.
--
--   optional    Tally's optional voucher: saved, visible, posted only when
--               someone decides it should be (a memorandum entry, a what-if).
--   post_dated  dated ahead; the scheduler posts it on its date, not before,
--               so no report counts it early.
--   approval    caught by a journal approval rule; posts when a second person
--               with the rule's role approves it.
--
-- The lines are kept exactly as entered and go through postManualJournal when
-- released, so a held entry posts precisely as a hand-posted one would.

CREATE TABLE IF NOT EXISTS held_journals (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  branch_id           BIGINT        NOT NULL,
  kind                ENUM('optional','post_dated','approval') NOT NULL,
  entry_date          DATE          NOT NULL,
  memo                VARCHAR(500)  NOT NULL,
  reverse_on          DATE          NULL,
  entry_lines         JSON          NOT NULL,
  total_amount        DECIMAL(18,2) NOT NULL,
  status              ENUM('held','posted','discarded','rejected') NOT NULL DEFAULT 'held',
  entry_id            BIGINT        NULL,
  created_by_user_id  BIGINT        NULL,
  decided_by_user_id  BIGINT        NULL,
  decided_at          TIMESTAMP     NULL,
  note                VARCHAR(500)  NULL,
  last_error          VARCHAR(500)  NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_hj_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_hj_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_hj_entry FOREIGN KEY (entry_id) REFERENCES journal_entries(id),
  KEY idx_hj_due (status, kind, entry_date),
  KEY idx_hj_org (org_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE approval_rules
  MODIFY COLUMN document_type ENUM('invoice','bill','journal') NOT NULL;
ALTER TABLE approval_actions
  MODIFY COLUMN document_type ENUM('invoice','bill','journal') NOT NULL;

-- Recurring profiles the scheduler runs on their own, and what stopped it last.
ALTER TABLE recurring_journals
  ADD COLUMN auto_run   TINYINT(1)   NOT NULL DEFAULT 0,
  ADD COLUMN last_error VARCHAR(500) NULL;
ALTER TABLE recurring_invoices
  ADD COLUMN auto_run   TINYINT(1)   NOT NULL DEFAULT 0,
  ADD COLUMN last_error VARCHAR(500) NULL;
