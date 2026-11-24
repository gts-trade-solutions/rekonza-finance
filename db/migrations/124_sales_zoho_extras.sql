-- What Zoho Books' sales screens have that Rekonza's did not yet carry
-- (recorded from Zoho's demo, 2026-11-23; built 2026-11-24).

-- Shipping Charges and an Adjustment (with its own label) at the foot of a
-- quote, sales order, delivery challan and credit note, as on an invoice
-- (migration 004). A quote's or order's pass through to the invoice it becomes;
-- a credit note's are credited back to the same income heads.
ALTER TABLE estimates
  ADD COLUMN shipping_charge  DECIMAL(19,4) NOT NULL DEFAULT 0,
  ADD COLUMN adjustment       DECIMAL(19,4) NOT NULL DEFAULT 0,
  ADD COLUMN adjustment_label VARCHAR(60)   NULL,
  -- "This transaction is applicable for reverse charge": the buyer pays the GST.
  ADD COLUMN reverse_charge   TINYINT(1)    NOT NULL DEFAULT 0,
  -- "Create a retainer invoice for this quote automatically", and how much of it.
  ADD COLUMN retainer_pct     DECIMAL(6,2)  NULL;

ALTER TABLE sales_orders
  ADD COLUMN shipping_charge  DECIMAL(19,4) NOT NULL DEFAULT 0,
  ADD COLUMN adjustment       DECIMAL(19,4) NOT NULL DEFAULT 0,
  ADD COLUMN adjustment_label VARCHAR(60)   NULL,
  ADD COLUMN reverse_charge   TINYINT(1)    NOT NULL DEFAULT 0;

ALTER TABLE delivery_challans
  ADD COLUMN shipping_charge  DECIMAL(19,4) NOT NULL DEFAULT 0,
  ADD COLUMN adjustment       DECIMAL(19,4) NOT NULL DEFAULT 0,
  ADD COLUMN adjustment_label VARCHAR(60)   NULL;

ALTER TABLE credit_notes
  ADD COLUMN shipping_charge  DECIMAL(19,4) NOT NULL DEFAULT 0,
  ADD COLUMN adjustment       DECIMAL(19,4) NOT NULL DEFAULT 0,
  ADD COLUMN adjustment_label VARCHAR(60)   NULL;

-- Zoho's credit note can be saved as a draft: posted nothing, reported nowhere,
-- applied to nothing, until it is converted to open.
ALTER TABLE credit_notes
  MODIFY COLUMN status ENUM('draft','open','applied','refunded','void') NOT NULL DEFAULT 'open';

-- An invoice under reverse charge (the buyer pays the GST: GSTR-1 rchrg Y) and
-- a bill of supply (exempt, nil-rated or non-GST goods, or a composition
-- dealer's sale: no tax at all, titled "Bill of Supply").
ALTER TABLE invoices
  ADD COLUMN reverse_charge TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN bill_of_supply TINYINT(1) NOT NULL DEFAULT 0;

-- Zoho's sales order "Cancel Items": quantity that will never be invoiced.
ALTER TABLE sales_order_lines
  ADD COLUMN qty_cancelled DECIMAL(19,4) NOT NULL DEFAULT 0;

-- Zoho's "Convert to Purchase Order": the order a purchase order was raised for.
ALTER TABLE purchase_orders
  ADD COLUMN source_sales_order_id BIGINT NULL,
  ADD KEY idx_po_source_so (org_id, source_sales_order_id);

-- The quote a retainer invoice was raised from automatically.
ALTER TABLE retainer_invoices
  ADD COLUMN source_estimate_id BIGINT NULL;

-- Zoho's per-module Preferences (Quote Preferences, Invoice Preferences …):
-- the default Customer Notes and Terms & Conditions each new document starts
-- with, and the module's switches (settings JSON, read by services/doc-preferences.ts).
CREATE TABLE IF NOT EXISTS document_preferences (
  org_id      BIGINT       NOT NULL,
  doc_type    VARCHAR(20)  NOT NULL,
  notes       TEXT         NULL,
  terms       TEXT         NULL,
  settings    JSON         NULL,
  updated_by_user_id BIGINT NULL,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id, doc_type)
);
