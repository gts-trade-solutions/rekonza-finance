-- 005_purchases.sql
-- Bills, expenses, purchase orders, vendor credits.
--
-- The purchase side carries three things sales does not, and each is a legal
-- obligation rather than a convenience:
--   * ITC eligibility per line — input credit on a car or a staff party is
--     blocked under Section 17(5), and claiming it is an assessment finding.
--   * Reverse charge — on some supplies the buyer pays the GST, not the
--     seller, so the bill both owes and reclaims the same tax.
--   * TDS — tax deducted at source, withheld from the vendor and paid to the
--     government under a section code that must be reported in the return.

CREATE TABLE IF NOT EXISTS bills (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  branch_id         BIGINT        NOT NULL,
  -- Our own reference. The vendor's number is theirs and may collide.
  internal_no       VARCHAR(50)   NOT NULL,
  vendor_invoice_no VARCHAR(60)   NOT NULL,
  vendor_id         BIGINT        NOT NULL,
  bill_date         DATE          NOT NULL,
  due_date          DATE          NOT NULL,
  place_of_supply   CHAR(2)       NOT NULL,
  supply_type       ENUM('intra','inter','export_lut','export_with_tax','sez','nil_or_exempt') NOT NULL,
  status            ENUM('draft','open','partially_paid','paid','overdue','void') NOT NULL DEFAULT 'draft',
  -- Reverse charge: we owe the GST on this purchase instead of the supplier.
  is_rcm            TINYINT(1)    NOT NULL DEFAULT 0,
  subtotal          DECIMAL(19,4) NOT NULL DEFAULT 0,
  cgst              DECIMAL(19,4) NOT NULL DEFAULT 0,
  sgst              DECIMAL(19,4) NOT NULL DEFAULT 0,
  igst              DECIMAL(19,4) NOT NULL DEFAULT 0,
  cess              DECIMAL(19,4) NOT NULL DEFAULT 0,
  tds_amount        DECIMAL(19,4) NOT NULL DEFAULT 0,
  tds_section       VARCHAR(10)   NULL,
  round_off         DECIMAL(19,4) NOT NULL DEFAULT 0,
  total             DECIMAL(19,4) NOT NULL DEFAULT 0,
  amount_paid       DECIMAL(19,4) NOT NULL DEFAULT 0,
  notes             VARCHAR(2000) NULL,
  source_po_id      BIGINT        NULL,
  journal_entry_id  BIGINT        NULL,
  voided_at         DATETIME      NULL,
  created_by_user_id BIGINT       NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_bill_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_bill_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_bill_vendor FOREIGN KEY (vendor_id) REFERENCES contacts(id),
  CONSTRAINT fk_bill_entry FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id),
  UNIQUE KEY uq_bill_internal (org_id, internal_no),
  -- The same vendor cannot bill us the same number twice. Catching this at
  -- entry is what stops a duplicate payment going out.
  UNIQUE KEY uq_bill_vendor_no (org_id, vendor_id, vendor_invoice_no),
  KEY idx_bill_org_date (org_id, bill_date),
  KEY idx_bill_vendor (org_id, vendor_id, bill_date),
  KEY idx_bill_status (org_id, status, due_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bill_lines (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id        BIGINT        NOT NULL,
  bill_id       BIGINT        NOT NULL,
  line_no       SMALLINT      NOT NULL,
  item_id       BIGINT        NULL,
  -- Expense or asset account when the line is not a catalogue item.
  account_id    BIGINT        NULL,
  description   VARCHAR(1000) NULL,
  hsn_sac       VARCHAR(8)    NULL,
  qty           DECIMAL(19,6) NOT NULL DEFAULT 1,
  uqc           VARCHAR(10)   NULL,
  rate          DECIMAL(19,4) NOT NULL DEFAULT 0,
  discount_pct  DECIMAL(9,4)  NOT NULL DEFAULT 0,
  gst_rate_pct  DECIMAL(6,3)  NOT NULL DEFAULT 0,
  taxable       DECIMAL(19,4) NOT NULL DEFAULT 0,
  cgst          DECIMAL(19,4) NOT NULL DEFAULT 0,
  sgst          DECIMAL(19,4) NOT NULL DEFAULT 0,
  igst          DECIMAL(19,4) NOT NULL DEFAULT 0,
  cess          DECIMAL(19,4) NOT NULL DEFAULT 0,
  line_total    DECIMAL(19,4) NOT NULL DEFAULT 0,
  -- 'ineligible' sends the GST into the cost instead of the credit ledger.
  itc_eligibility ENUM('eligible','ineligible','capital_goods') NOT NULL DEFAULT 'eligible',
  CONSTRAINT fk_billl_bill FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE,
  CONSTRAINT fk_billl_item FOREIGN KEY (item_id) REFERENCES items(id),
  CONSTRAINT fk_billl_account FOREIGN KEY (account_id) REFERENCES accounts(id),
  UNIQUE KEY uq_billl (bill_id, line_no),
  KEY idx_billl_hsn (org_id, hsn_sac)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- An expense is money already spent, with no vendor bill to track and settle
-- later. It posts and closes in one step.
CREATE TABLE IF NOT EXISTS expenses (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  branch_id         BIGINT        NOT NULL,
  number            VARCHAR(50)   NOT NULL,
  expense_date      DATE          NOT NULL,
  account_id        BIGINT        NOT NULL,
  vendor_id         BIGINT        NULL,
  paid_through_bank_account_id BIGINT NOT NULL,
  amount            DECIMAL(19,4) NOT NULL DEFAULT 0,
  gst_rate_pct      DECIMAL(6,3)  NOT NULL DEFAULT 0,
  cgst              DECIMAL(19,4) NOT NULL DEFAULT 0,
  sgst              DECIMAL(19,4) NOT NULL DEFAULT 0,
  igst              DECIMAL(19,4) NOT NULL DEFAULT 0,
  total             DECIMAL(19,4) NOT NULL DEFAULT 0,
  itc_eligibility   ENUM('eligible','ineligible','capital_goods') NOT NULL DEFAULT 'eligible',
  -- Billable expenses get re-charged to a customer on their next invoice.
  is_billable       TINYINT(1)    NOT NULL DEFAULT 0,
  billable_customer_id BIGINT     NULL,
  reference         VARCHAR(100)  NULL,
  notes             VARCHAR(1000) NULL,
  receipt_file_id   BIGINT        NULL,
  status            ENUM('recorded','void') NOT NULL DEFAULT 'recorded',
  journal_entry_id  BIGINT        NULL,
  created_by_user_id BIGINT       NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_exp_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_exp_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_exp_account FOREIGN KEY (account_id) REFERENCES accounts(id),
  CONSTRAINT fk_exp_vendor FOREIGN KEY (vendor_id) REFERENCES contacts(id),
  CONSTRAINT fk_exp_entry FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id),
  UNIQUE KEY uq_exp_org_number (org_id, number),
  KEY idx_exp_org_date (org_id, expense_date),
  KEY idx_exp_account (org_id, account_id, expense_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS purchase_orders (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  branch_id         BIGINT        NOT NULL,
  number            VARCHAR(50)   NOT NULL,
  vendor_id         BIGINT        NOT NULL,
  order_date        DATE          NOT NULL,
  expected_date     DATE          NULL,
  place_of_supply   CHAR(2)       NOT NULL,
  supply_type       ENUM('intra','inter','export_lut','export_with_tax','sez','nil_or_exempt') NOT NULL,
  status            ENUM('draft','open','partially_billed','billed','closed','cancelled') NOT NULL DEFAULT 'draft',
  subtotal          DECIMAL(19,4) NOT NULL DEFAULT 0,
  cgst              DECIMAL(19,4) NOT NULL DEFAULT 0,
  sgst              DECIMAL(19,4) NOT NULL DEFAULT 0,
  igst              DECIMAL(19,4) NOT NULL DEFAULT 0,
  cess              DECIMAL(19,4) NOT NULL DEFAULT 0,
  total             DECIMAL(19,4) NOT NULL DEFAULT 0,
  billed_amount     DECIMAL(19,4) NOT NULL DEFAULT 0,
  notes             VARCHAR(2000) NULL,
  created_by_user_id BIGINT       NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_po_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_po_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_po_vendor FOREIGN KEY (vendor_id) REFERENCES contacts(id),
  UNIQUE KEY uq_po_branch_number (org_id, branch_id, number),
  KEY idx_po_org_date (org_id, order_date),
  KEY idx_po_vendor (org_id, vendor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id        BIGINT        NOT NULL,
  purchase_order_id BIGINT    NOT NULL,
  line_no       SMALLINT      NOT NULL,
  item_id       BIGINT        NULL,
  account_id    BIGINT        NULL,
  description   VARCHAR(1000) NULL,
  hsn_sac       VARCHAR(8)    NULL,
  qty           DECIMAL(19,6) NOT NULL DEFAULT 1,
  uqc           VARCHAR(10)   NULL,
  rate          DECIMAL(19,4) NOT NULL DEFAULT 0,
  discount_pct  DECIMAL(9,4)  NOT NULL DEFAULT 0,
  gst_rate_pct  DECIMAL(6,3)  NOT NULL DEFAULT 0,
  taxable       DECIMAL(19,4) NOT NULL DEFAULT 0,
  cgst          DECIMAL(19,4) NOT NULL DEFAULT 0,
  sgst          DECIMAL(19,4) NOT NULL DEFAULT 0,
  igst          DECIMAL(19,4) NOT NULL DEFAULT 0,
  cess          DECIMAL(19,4) NOT NULL DEFAULT 0,
  line_total    DECIMAL(19,4) NOT NULL DEFAULT 0,
  CONSTRAINT fk_pol_po FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_pol_item FOREIGN KEY (item_id) REFERENCES items(id),
  CONSTRAINT fk_pol_account FOREIGN KEY (account_id) REFERENCES accounts(id),
  UNIQUE KEY uq_pol (purchase_order_id, line_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS vendor_credits (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  branch_id         BIGINT        NOT NULL,
  number            VARCHAR(50)   NOT NULL,
  vendor_id         BIGINT        NOT NULL,
  credit_date       DATE          NOT NULL,
  reason            VARCHAR(200)  NOT NULL,
  against_bill_id   BIGINT        NULL,
  status            ENUM('open','applied','refunded','void') NOT NULL DEFAULT 'open',
  total             DECIMAL(19,4) NOT NULL DEFAULT 0,
  applied_amount    DECIMAL(19,4) NOT NULL DEFAULT 0,
  journal_entry_id  BIGINT        NULL,
  created_by_user_id BIGINT       NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_vc_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_vc_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_vc_vendor FOREIGN KEY (vendor_id) REFERENCES contacts(id),
  CONSTRAINT fk_vc_bill FOREIGN KEY (against_bill_id) REFERENCES bills(id),
  CONSTRAINT fk_vc_entry FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id),
  UNIQUE KEY uq_vc_branch_number (org_id, branch_id, number),
  KEY idx_vc_org_date (org_id, credit_date),
  KEY idx_vc_vendor (org_id, vendor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
