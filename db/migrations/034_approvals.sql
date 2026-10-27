-- Approvals: a second person before a document reaches the books.
--
-- approval_rules has existed since 007 and nothing read it. A rule says that
-- invoices (or bills) of at least some amount need approving by a role. A
-- document caught by a rule is saved as a draft, submitted, and posted only
-- when someone with that role, who is not the person who submitted it,
-- approves it. Each step is kept, with who and when.

ALTER TABLE invoices
  ADD COLUMN approval_status ENUM('none','pending','approved','rejected') NOT NULL DEFAULT 'none' AFTER status,
  ADD COLUMN submitted_by_user_id BIGINT NULL AFTER approval_status,
  ADD COLUMN submitted_at TIMESTAMP NULL AFTER submitted_by_user_id,
  ADD COLUMN approved_by_user_id BIGINT NULL AFTER submitted_at,
  ADD COLUMN approved_at TIMESTAMP NULL AFTER approved_by_user_id,
  ADD COLUMN rejection_reason VARCHAR(500) NULL AFTER approved_at;

ALTER TABLE bills
  ADD COLUMN approval_status ENUM('none','pending','approved','rejected') NOT NULL DEFAULT 'none' AFTER status,
  ADD COLUMN submitted_by_user_id BIGINT NULL AFTER approval_status,
  ADD COLUMN submitted_at TIMESTAMP NULL AFTER submitted_by_user_id,
  ADD COLUMN approved_by_user_id BIGINT NULL AFTER submitted_at,
  ADD COLUMN approved_at TIMESTAMP NULL AFTER approved_by_user_id,
  ADD COLUMN rejection_reason VARCHAR(500) NULL AFTER approved_at;

CREATE TABLE IF NOT EXISTS approval_actions (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id          BIGINT        NOT NULL,
  document_type   ENUM('invoice','bill') NOT NULL,
  document_id     BIGINT        NOT NULL,
  action          ENUM('submitted','approved','rejected') NOT NULL,
  user_id         BIGINT        NULL,
  note            VARCHAR(500)  NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_apact_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  KEY idx_apact_doc (org_id, document_type, document_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rules are per document kind; the old free-text column now takes only the
-- kinds the posting code checks.
UPDATE approval_rules SET document_type = 'invoice' WHERE document_type NOT IN ('invoice', 'bill');
ALTER TABLE approval_rules
  MODIFY COLUMN document_type ENUM('invoice','bill') NOT NULL;
