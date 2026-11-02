-- Debit notes and sales receipts, both kept as invoices.
--
-- A debit note (section 34(3) of the CGST Act) is raised when an invoice
-- charged too little: a price revised upward, goods short-billed. It is posted
-- exactly as an invoice is, and GSTR-3B and the HSN summary count it as an
-- outward supply, so it lives in the invoices table, marked as what it is.
-- GSTR-1 reports it apart, in the credit/debit note tables with note type D,
-- and the IRP takes it as document type DBN. Rule 53(1A) wants the invoice it
-- corrects named on it, hence `against_invoice_id`. It is numbered in its own
-- series: Rule 46(b) wants a consecutive series per kind of document.
--
-- A sales receipt is a sale paid for on the spot: an invoice and its receipt
-- recorded together. `paid_at_sale` keeps the two findable as one, for the
-- Sales receipts list.

ALTER TABLE invoices
  ADD COLUMN doc_kind ENUM('invoice','debit_note') NOT NULL DEFAULT 'invoice' AFTER number,
  ADD COLUMN against_invoice_id BIGINT NULL AFTER doc_kind,
  ADD COLUMN note_reason VARCHAR(255) NULL AFTER against_invoice_id,
  ADD COLUMN paid_at_sale TINYINT(1) NOT NULL DEFAULT 0;

CREATE INDEX idx_invoices_kind ON invoices (org_id, doc_kind, invoice_date);
