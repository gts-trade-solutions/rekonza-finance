-- The self-invoice a buyer issues for a reverse-charge purchase from a
-- supplier who is not registered (CGST Act s.31(3)(f), Rule 47A: within 30
-- days of receiving the supply), from its own series, as Rule 46 numbers go.
ALTER TABLE bills
  ADD COLUMN self_invoice_no VARCHAR(16) NULL AFTER is_rcm,
  ADD UNIQUE KEY uq_bills_self_invoice (org_id, self_invoice_no);
