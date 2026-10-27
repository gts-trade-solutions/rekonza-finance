-- The order flow, line by line.
--
--   Sales:     quotation → sales order → delivery challan → invoice
--   Purchases: purchase order → goods receipt note → bill
--
-- Each step could already be raised, but a conversion copied the whole of the
-- previous document every time, so a half-delivered order invoiced twice in
-- full. Now every line carries what has gone on from it, and each document
-- line remembers the line it came from.
--
-- A goods receipt note is the one new document. Goods are in the store before
-- the supplier's bill arrives; the note brings them into stock and, so the
-- profit is not overstated meanwhile, accrues their cost against a "goods
-- received, bill pending" liability that the bill clears.
--
-- A bill raised from an order or a receipt is matched against them. One that
-- disagrees (more billed than received, or a price above the order's) is held
-- back from payment until someone with approval rights accepts it.

ALTER TABLE sales_order_lines
  ADD COLUMN qty_delivered DECIMAL(19,6) NOT NULL DEFAULT 0 AFTER qty,
  ADD COLUMN qty_invoiced  DECIMAL(19,6) NOT NULL DEFAULT 0 AFTER qty_delivered;

ALTER TABLE delivery_challans
  ADD COLUMN source_so_id BIGINT NULL AFTER customer_id,
  MODIFY COLUMN status ENUM('open','partially_invoiced','invoiced','returned','cancelled') NOT NULL DEFAULT 'open';

ALTER TABLE challan_lines
  ADD COLUMN so_line_id   BIGINT        NULL AFTER challan_id,
  ADD COLUMN qty_invoiced DECIMAL(19,6) NOT NULL DEFAULT 0 AFTER qty;

ALTER TABLE invoice_lines
  ADD COLUMN source_line_type VARCHAR(20) NULL AFTER invoice_id,
  ADD COLUMN source_line_id   BIGINT      NULL AFTER source_line_type,
  ADD KEY idx_invl_source (source_line_type, source_line_id);

ALTER TABLE purchase_order_lines
  ADD COLUMN qty_received DECIMAL(19,6) NOT NULL DEFAULT 0 AFTER qty,
  ADD COLUMN qty_billed   DECIMAL(19,6) NOT NULL DEFAULT 0 AFTER qty_received;

CREATE TABLE IF NOT EXISTS goods_receipts (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  branch_id         BIGINT        NOT NULL,
  number            VARCHAR(50)   NOT NULL,
  vendor_id         BIGINT        NOT NULL,
  source_po_id      BIGINT        NULL,
  receipt_date      DATE          NOT NULL,
  -- The supplier's delivery challan or e-way bill, as written on it.
  vendor_challan_no VARCHAR(50)   NULL,
  status            ENUM('open','partially_billed','billed','cancelled') NOT NULL DEFAULT 'open',
  total             DECIMAL(19,4) NOT NULL DEFAULT 0,
  notes             VARCHAR(2000) NULL,
  journal_entry_id  BIGINT        NULL,
  created_by_user_id BIGINT       NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_grn_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_grn_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_grn_vendor FOREIGN KEY (vendor_id) REFERENCES contacts(id),
  CONSTRAINT fk_grn_po FOREIGN KEY (source_po_id) REFERENCES purchase_orders(id),
  CONSTRAINT fk_grn_entry FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id),
  UNIQUE KEY uq_grn_branch_number (org_id, branch_id, number),
  KEY idx_grn_org_date (org_id, receipt_date),
  KEY idx_grn_vendor (org_id, vendor_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS goods_receipt_lines (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id        BIGINT        NOT NULL,
  receipt_id    BIGINT        NOT NULL,
  po_line_id    BIGINT        NULL,
  line_no       SMALLINT      NOT NULL,
  item_id       BIGINT        NULL,
  -- Where the cost was accrued, so the bill takes it back from the same place.
  account_id    BIGINT        NULL,
  description   VARCHAR(1000) NULL,
  hsn_sac       VARCHAR(8)    NULL,
  qty           DECIMAL(19,6) NOT NULL,
  qty_billed    DECIMAL(19,6) NOT NULL DEFAULT 0,
  uqc           VARCHAR(10)   NULL,
  -- The cost the goods are carried at until the bill gives the real one.
  rate          DECIMAL(19,4) NOT NULL DEFAULT 0,
  gst_rate_pct  DECIMAL(6,3)  NOT NULL DEFAULT 0,
  line_total    DECIMAL(19,4) NOT NULL DEFAULT 0,
  CONSTRAINT fk_grnl_receipt FOREIGN KEY (receipt_id) REFERENCES goods_receipts(id) ON DELETE CASCADE,
  CONSTRAINT fk_grnl_item FOREIGN KEY (item_id) REFERENCES items(id),
  CONSTRAINT ck_grnl_qty CHECK (qty > 0 AND qty_billed >= 0 AND qty_billed <= qty),
  UNIQUE KEY uq_grnl (receipt_id, line_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE bills
  ADD COLUMN source_grn_id BIGINT NULL AFTER source_po_id,
  -- not_required: raised from nothing. matched: agrees with its order and
  -- receipt. exception: does not, and cannot be paid. accepted: did not, and
  -- someone with approval rights said pay it anyway.
  ADD COLUMN match_status ENUM('not_required','matched','exception','accepted') NOT NULL DEFAULT 'not_required' AFTER status,
  ADD COLUMN match_note   VARCHAR(1000) NULL AFTER match_status,
  ADD COLUMN match_accepted_by_user_id BIGINT NULL AFTER match_note,
  ADD COLUMN match_accepted_at TIMESTAMP NULL AFTER match_accepted_by_user_id;

ALTER TABLE bill_lines
  ADD COLUMN source_line_type VARCHAR(20) NULL AFTER bill_id,
  ADD COLUMN source_line_id   BIGINT      NULL AFTER source_line_type,
  ADD KEY idx_billl_source (source_line_type, source_line_id);

-- The liability for goods in the store whose bill has not come.
INSERT INTO accounts (org_id, code, name, type, subtype, description, is_system, is_active)
SELECT o.id, '2150', 'Goods received, bill pending', 'liability', 'current',
       'The cost of goods received on a goods receipt note until the supplier''s bill is entered', 1, 1
  FROM organizations o
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id AND a.code = '2150');
