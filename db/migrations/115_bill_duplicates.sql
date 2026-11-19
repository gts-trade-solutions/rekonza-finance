-- A supplier's bill number is entered once — but a voided bill should not
-- block the corrected one carrying the same number.
--
--   vendor_invoice_key   the vendor's bill number while the bill stands, NULL
--                        once it is void. The unique key moves onto it, and a
--                        unique key allows any number of NULLs, so every live
--                        bill still has its own number per vendor.

ALTER TABLE bills
  ADD COLUMN vendor_invoice_key VARCHAR(60) COLLATE utf8mb4_unicode_ci
    GENERATED ALWAYS AS (IF(status = 'void', NULL, vendor_invoice_no)) STORED AFTER vendor_invoice_no;

ALTER TABLE bills
  DROP INDEX uq_bill_vendor_no,
  ADD UNIQUE KEY uq_bill_vendor_no (org_id, vendor_id, vendor_invoice_key);
