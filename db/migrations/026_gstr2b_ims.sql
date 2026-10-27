-- 026_gstr2b_ims.sql
-- GSTR-2B as the portal issues it, and what the business did about each line
-- in the Invoice Management System.
--
-- Until now 2B rows only came from the demo seed. They now come from the JSON
-- file the portal lets a taxpayer download (Returns → GSTR-2B), one file per
-- GSTIN per month, so the row needs to say which of our registrations it was
-- issued to, and whether it is an invoice or a note.
--
-- IMS (live on the portal since October 2024) is where the recipient accepts,
-- rejects or keeps pending each supplier document before 2B is generated. A
-- document left without an action is deemed accepted. The action is recorded
-- here so the reconciliation and the claim agree with what was done on the
-- portal.

ALTER TABLE gstr2b_entries
  ADD COLUMN recipient_gstin CHAR(15) NULL AFTER return_period,
  ADD COLUMN doc_type ENUM('invoice','credit_note','debit_note') NOT NULL DEFAULT 'invoice' AFTER vendor_name,
  ADD COLUMN is_reverse_charge TINYINT(1) NOT NULL DEFAULT 0 AFTER itc_available,
  ADD COLUMN source ENUM('seed','upload','provider') NOT NULL DEFAULT 'seed' AFTER match_status,
  ADD COLUMN ims_action ENUM('accepted','rejected','pending') NULL AFTER source,
  ADD COLUMN ims_note VARCHAR(300) NULL AFTER ims_action,
  ADD COLUMN ims_action_by_user_id BIGINT NULL AFTER ims_note,
  ADD COLUMN ims_action_at DATETIME NULL AFTER ims_action_by_user_id,
  ADD COLUMN imported_at DATETIME NULL AFTER ims_action_at;

-- A credit note can share its number with an invoice from the same supplier.
ALTER TABLE gstr2b_entries
  DROP INDEX uq_2b,
  ADD UNIQUE KEY uq_2b (org_id, return_period, vendor_gstin, doc_type, invoice_no);
