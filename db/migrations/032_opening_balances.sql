-- Opening balances: where the books start.
--
-- Ledger openings were always journal entries against Opening Balance Equity
-- (3300), but nothing could enter them. What a customer or vendor owed on day
-- one could not be entered at all: contacts.opening_balance was never posted,
-- and a single figure cannot be aged or paid off bill by bill.
--
-- So a party's opening is held as its old bills, each with its number, date,
-- due date and amount. Each posts to the party's ledger against 3300 on the
-- books' start date, ages from its own due date, and can be settled by a
-- receipt or payment like any invoice or bill.

ALTER TABLE organizations
  ADD COLUMN books_start_date DATE NULL AFTER fiscal_year_start_month;

CREATE TABLE IF NOT EXISTS opening_documents (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  branch_id         BIGINT        NOT NULL,
  contact_id        BIGINT        NOT NULL,
  kind              ENUM('receivable','payable') NOT NULL,
  ref_no            VARCHAR(50)   NOT NULL,
  doc_date          DATE          NOT NULL,
  due_date          DATE          NOT NULL,
  amount            DECIMAL(19,4) NOT NULL,
  amount_paid       DECIMAL(19,4) NOT NULL DEFAULT 0,
  status            ENUM('open','partially_paid','paid','void') NOT NULL DEFAULT 'open',
  notes             VARCHAR(500)  NULL,
  journal_entry_id  BIGINT        NULL,
  created_by_user_id BIGINT       NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_od_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_od_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_od_contact FOREIGN KEY (contact_id) REFERENCES contacts(id),
  CONSTRAINT fk_od_entry FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id),
  CONSTRAINT ck_od_amount CHECK (amount > 0 AND amount_paid >= 0 AND amount_paid <= amount),
  UNIQUE KEY uq_od_ref (org_id, contact_id, kind, ref_no),
  KEY idx_od_open (org_id, kind, status, due_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A receipt or payment can now settle an opening bill.
ALTER TABLE payment_allocations
  MODIFY COLUMN target_type ENUM('invoice','bill','credit_note','vendor_credit','retainer','opening') NOT NULL;
