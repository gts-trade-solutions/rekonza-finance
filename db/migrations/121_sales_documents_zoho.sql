-- Quotes, sales orders, delivery challans and credit notes, with the fields
-- Zoho Books' forms have for them (recorded from Zoho's demo, 2026-11-23):
--
--   Quote:          Reference#, Salesperson, Project Name, Terms & Conditions
--   Sales Order:    Reference#, Salesperson, Payment Terms, Delivery Method,
--                   Customer Notes, Terms & Conditions
--   Delivery Challan: Reference#, Terms & Conditions
--   Credit Note:    Reference#, Salesperson, Customer Notes, Terms & Conditions
--
-- None of them changes a figure: they print on the document, show on its
-- record and pass through to the invoice it becomes. Customer Notes already
-- existed on quotes and challans (notes).

ALTER TABLE estimates
  ADD COLUMN reference_number VARCHAR(100) NULL AFTER number,
  ADD COLUMN salesperson_id   BIGINT       NULL AFTER customer_id,
  ADD COLUMN project_id       BIGINT       NULL AFTER salesperson_id,
  ADD COLUMN terms            TEXT         NULL AFTER notes;

ALTER TABLE sales_orders
  ADD COLUMN reference_number VARCHAR(100) NULL AFTER number,
  ADD COLUMN salesperson_id   BIGINT       NULL AFTER customer_id,
  ADD COLUMN payment_terms    VARCHAR(30)  NULL AFTER expected_ship_date,
  ADD COLUMN delivery_method  VARCHAR(100) NULL AFTER payment_terms,
  ADD COLUMN notes            TEXT         NULL,
  ADD COLUMN terms            TEXT         NULL;

ALTER TABLE delivery_challans
  ADD COLUMN reference_number VARCHAR(100) NULL AFTER number,
  ADD COLUMN terms            TEXT         NULL AFTER notes;

ALTER TABLE credit_notes
  ADD COLUMN reference_number VARCHAR(100) NULL AFTER number,
  ADD COLUMN salesperson_id   BIGINT       NULL AFTER customer_id,
  ADD COLUMN notes            TEXT         NULL,
  ADD COLUMN terms            TEXT         NULL;

-- Zoho's sales order is saved as a draft or confirmed. A draft is an order
-- still being agreed: nothing is delivered or invoiced against it, and no
-- proforma is raised, until it is confirmed (services/order-flow.ts,
-- services/order-stages.ts). "open" stays the confirmed order.
ALTER TABLE sales_orders
  MODIFY COLUMN status ENUM('draft','open','partially_invoiced','invoiced','closed','cancelled') NOT NULL DEFAULT 'open';

-- A delivery challan is saved as a draft in Zoho and marked open when the
-- goods go; nothing is invoiced against a draft.
ALTER TABLE delivery_challans
  MODIFY COLUMN status ENUM('draft','open','partially_invoiced','invoiced','returned','cancelled') NOT NULL DEFAULT 'open';
