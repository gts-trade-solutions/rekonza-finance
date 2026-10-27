-- Payment batches: the week's supplier payments chosen together, approved by a
-- second person where a rule asks for one, sent to the bank as one bulk file,
-- and recorded as payments once the bank has made them.
--
-- A line is a bill and how much of it to pay. The bank file has one transfer
-- per supplier, so a supplier with three bills receives one credit naming all
-- three, and the payment recorded for it settles the three.
--
-- The supplier's bank details are copied onto the line when the batch is
-- approved: the file then pays the account the approver saw, even if somebody
-- edits the supplier afterwards.

CREATE TABLE IF NOT EXISTS payment_batches (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id               BIGINT        NOT NULL,
  branch_id            BIGINT        NOT NULL,
  number               VARCHAR(30)   NOT NULL,
  bank_account_id      BIGINT        NOT NULL,
  pay_date             DATE          NOT NULL,
  status               ENUM('draft','pending','approved','paid','rejected','cancelled') NOT NULL DEFAULT 'draft',
  total_amount         DECIMAL(18,2) NOT NULL DEFAULT 0,
  notes                VARCHAR(500)  NULL,
  created_by_user_id   BIGINT        NULL,
  submitted_at         TIMESTAMP     NULL,
  approved_by_user_id  BIGINT        NULL,
  approved_at          TIMESTAMP     NULL,
  rejection_reason     VARCHAR(500)  NULL,
  file_downloaded_at   TIMESTAMP     NULL,
  paid_at              TIMESTAMP     NULL,
  created_at           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pb_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_pb_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_pb_bank FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id),
  UNIQUE KEY uq_pb_number (org_id, number),
  KEY idx_pb_status (org_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payment_batch_lines (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  batch_id             BIGINT        NOT NULL,
  org_id               BIGINT        NOT NULL,
  vendor_id            BIGINT        NOT NULL,
  bill_id              BIGINT        NOT NULL,
  amount               DECIMAL(18,2) NOT NULL,
  beneficiary_name     VARCHAR(200)  NULL,
  account_no           VARCHAR(40)   NULL,
  ifsc                 VARCHAR(11)   NULL,
  payment_id           BIGINT        NULL,
  CONSTRAINT fk_pbl_batch FOREIGN KEY (batch_id) REFERENCES payment_batches(id) ON DELETE CASCADE,
  CONSTRAINT fk_pbl_vendor FOREIGN KEY (vendor_id) REFERENCES contacts(id),
  CONSTRAINT fk_pbl_bill FOREIGN KEY (bill_id) REFERENCES bills(id),
  CONSTRAINT fk_pbl_payment FOREIGN KEY (payment_id) REFERENCES payments(id),
  KEY idx_pbl_bill (bill_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE approval_rules
  MODIFY COLUMN document_type ENUM('invoice','bill','journal','payment_batch') NOT NULL;
ALTER TABLE approval_actions
  MODIFY COLUMN document_type ENUM('invoice','bill','journal','payment_batch') NOT NULL;
