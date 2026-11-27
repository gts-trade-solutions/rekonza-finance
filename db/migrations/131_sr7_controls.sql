-- Status review 7 (2026-11-27): the auditors' items 3, 5, 6, 7 and 8, which
-- they marked "Not Resolved" a second time. One file for all five, because
-- they were built together; each block says which item it serves.

-- ── Item 5: FIFO valuation variance ─────────────────────────────────────────
--
-- A return to a supplier now carries its goods, line by line, as a bill does.
-- Before this a vendor credit was an amount only, so goods sent back never
-- left the stock figures or the FIFO layers, and the Inventory account and the
-- valuation report drifted apart by every return. A line may name the bill line
-- the goods came in on (bill_line_id): its units then come out of that very
-- purchase layer, which is what Ind AS 2 / AS 2 FIFO means for a return of
-- specific goods. stock_cost is what the line took out of stock on a perpetual
-- book, so the record says what was posted.
CREATE TABLE IF NOT EXISTS vendor_credit_lines (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  vendor_credit_id  BIGINT        NOT NULL,
  line_no           INT           NOT NULL,
  item_id           BIGINT        NULL,
  bill_line_id      BIGINT        NULL,
  description       VARCHAR(500)  NULL,
  hsn_sac           VARCHAR(8)    NULL,
  qty               DECIMAL(18,4) NOT NULL DEFAULT 1,
  uqc               VARCHAR(10)   NULL,
  rate              DECIMAL(19,4) NOT NULL DEFAULT 0,
  gst_rate_pct      DECIMAL(6,3)  NOT NULL DEFAULT 0,
  taxable           DECIMAL(19,4) NOT NULL DEFAULT 0,
  cgst              DECIMAL(19,4) NOT NULL DEFAULT 0,
  sgst              DECIMAL(19,4) NOT NULL DEFAULT 0,
  igst              DECIMAL(19,4) NOT NULL DEFAULT 0,
  cess              DECIMAL(19,4) NOT NULL DEFAULT 0,
  line_total        DECIMAL(19,4) NOT NULL DEFAULT 0,
  stock_cost        DECIMAL(19,4) NULL,
  CONSTRAINT fk_vcl_vc FOREIGN KEY (vendor_credit_id) REFERENCES vendor_credits(id) ON DELETE CASCADE,
  CONSTRAINT fk_vcl_item FOREIGN KEY (item_id) REFERENCES items(id),
  UNIQUE KEY uq_vcl (vendor_credit_id, line_no),
  KEY idx_vcl_item (org_id, item_id),
  KEY idx_vcl_bill_line (bill_line_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The Inventory account, item by item. Every journal line that debits or
-- credits Inventory for a particular item writes one row here, in the same
-- entry (ledger/posting.ts), and a reversal writes the mirror rows. Summed to a
-- date, the rows are each item's balance in the ledger, which the "Stock
-- valuation vs ledger" report sets against the item's value per the valuation;
-- what the Inventory account holds beyond them (a manual journal, entries made
-- before item-wise tracking began) is reported separately, with its entries.
-- source_type 'baseline' is the starting split of a perpetual book that had
-- Inventory postings before this table existed (services/stock-ledger.ts).
CREATE TABLE IF NOT EXISTS stock_postings (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id        BIGINT        NOT NULL,
  entry_id      BIGINT        NULL,
  item_id       BIGINT        NOT NULL,
  posting_date  DATE          NOT NULL,
  amount        DECIMAL(19,4) NOT NULL,
  source_type   VARCHAR(30)   NOT NULL,
  source_id     BIGINT        NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_stp_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_stp_item FOREIGN KEY (item_id) REFERENCES items(id),
  KEY idx_stp_item (org_id, item_id, posting_date),
  KEY idx_stp_entry (entry_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A production run on a perpetual book now posts as it is recorded (finished
-- goods in, components out), so it keeps the entry it made.
ALTER TABLE productions ADD COLUMN journal_entry_id BIGINT NULL AFTER warehouse_id;

-- ── Item 7: credit note workflow ────────────────────────────────────────────
--
-- Credit notes go through maker and checker like invoices and bills: a rule
-- (Settings → Approvals) catches a credit note of at least its amount, which
-- then waits as a draft until someone else approves it. A credit note gives
-- money back to a customer and cuts output tax (CGST Act s.34), so it is as
-- much a control point as the invoice it reduces.
ALTER TABLE credit_notes
  ADD COLUMN approval_status ENUM('none','pending','approved','rejected') NOT NULL DEFAULT 'none' AFTER status,
  ADD COLUMN submitted_by_user_id BIGINT NULL AFTER approval_status,
  ADD COLUMN submitted_at TIMESTAMP NULL AFTER submitted_by_user_id,
  ADD COLUMN approved_by_user_id BIGINT NULL AFTER submitted_at,
  ADD COLUMN approved_at TIMESTAMP NULL AFTER approved_by_user_id,
  ADD COLUMN rejection_reason VARCHAR(500) NULL AFTER approved_at;

-- NOTE for merging: these two lists are the whole enum. A later migration that
-- adds another document type must repeat 'credit_note' in its own list.
ALTER TABLE approval_rules
  MODIFY COLUMN document_type ENUM('invoice','bill','journal','payment_batch','credit_note') COLLATE utf8mb4_unicode_ci NOT NULL;
ALTER TABLE approval_actions
  MODIFY COLUMN document_type ENUM('invoice','bill','journal','payment_batch','credit_note') COLLATE utf8mb4_unicode_ci NOT NULL;

-- ── Item 8: duplicate invoice detection ─────────────────────────────────────
--
-- The "Possible duplicate bills" register. A supplier's invoice saved although
-- it looked like one already in the books (the same amount from the same
-- vendor within a few days under another number, the same number from another
-- contact with the same GSTIN, the same customer PO twice) is kept here with
-- what it resembled and the reason the person gave when they saved it, until
-- an accountant clears it (not a duplicate) or confirms it (a duplicate, to be
-- voided). A bill paid twice is the commonest fraud and the commonest error in
-- payables; the register is the evidence the check ran and was looked at.
CREATE TABLE IF NOT EXISTS duplicate_reviews (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id               BIGINT        NOT NULL,
  doc_type             ENUM('bill','expense','goods_receipt','invoice') COLLATE utf8mb4_unicode_ci NOT NULL,
  doc_id               BIGINT        NOT NULL,
  twin_type            ENUM('bill','expense','goods_receipt','invoice') COLLATE utf8mb4_unicode_ci NOT NULL,
  twin_id              BIGINT        NOT NULL,
  why                  VARCHAR(300)  NOT NULL,
  entered_reason       VARCHAR(500)  NULL,
  entered_by_user_id   BIGINT        NULL,
  status               ENUM('open','cleared','confirmed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'open',
  reviewed_by_user_id  BIGINT        NULL,
  reviewed_at          TIMESTAMP     NULL,
  review_note          VARCHAR(500)  NULL,
  created_at           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_dupr_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_dupr_pair (org_id, doc_type, doc_id, twin_type, twin_id),
  KEY idx_dupr_status (org_id, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Item 3: bulk import validation ──────────────────────────────────────────
--
-- Every import that kept anything: who ran it, when, from which file, how many
-- rows went in, were skipped as already there, or failed and why — the import
-- history an auditor reads (Settings → Import → Import History). created_ids
-- lists what the import made, by table, so an import of masters nothing has
-- used yet can be undone whole.
CREATE TABLE IF NOT EXISTS import_batches (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  module              VARCHAR(40)   NOT NULL,
  kind                VARCHAR(40)   NOT NULL,
  file_name           VARCHAR(255)  NULL,
  file_format         VARCHAR(12)   NULL,
  mode                ENUM('all','valid_only') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'all',
  rows_total          INT           NOT NULL DEFAULT 0,
  imported            INT           NOT NULL DEFAULT 0,
  skipped             INT           NOT NULL DEFAULT 0,
  failed              INT           NOT NULL DEFAULT 0,
  errors              JSON          NULL,
  created_ids         JSON          NULL,
  note                VARCHAR(500)  NULL,
  status              ENUM('imported','undone') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'imported',
  created_by_user_id  BIGINT        NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  undone_by_user_id   BIGINT        NULL,
  undone_at           TIMESTAMP     NULL,
  CONSTRAINT fk_impb_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  KEY idx_impb_org (org_id, created_at),
  KEY idx_impb_module (org_id, module, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Item 6: bulk payment upload ─────────────────────────────────────────────
--
-- The bank's reply to a bulk payment file: each transfer paid (with its UTR)
-- or failed (with the bank's reason), read from the status file the bank's
-- corporate portal gives back. A failed transfer leaves its bills unpaid and
-- free for the next batch.
ALTER TABLE payment_batch_lines
  ADD COLUMN bank_status ENUM('pending','paid','failed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending' AFTER payment_id,
  ADD COLUMN utr VARCHAR(40) NULL AFTER bank_status,
  ADD COLUMN failure_reason VARCHAR(300) NULL AFTER utr;

-- Which bank's layout the file was made in, so the status file is read in the same one.
ALTER TABLE payment_batches
  ADD COLUMN bank_format VARCHAR(20) NULL AFTER file_downloaded_at;
