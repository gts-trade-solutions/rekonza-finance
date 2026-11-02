-- Every document prints, saves as a PDF and goes by email, as in Zoho Books:
-- quotes, sales orders, delivery challans, credit notes, retainer invoices,
-- payment receipts, purchase orders, vendor credits and payment advices, not
-- only invoices. A link sent by email opens the document's printed copy; the
-- kind of document (lib/print-doc.ts) is kept beside its id.
ALTER TABLE share_links
  MODIFY COLUMN doc_type ENUM('invoice','payslip','document') NOT NULL,
  ADD COLUMN doc_kind VARCHAR(20) NULL AFTER doc_type;
