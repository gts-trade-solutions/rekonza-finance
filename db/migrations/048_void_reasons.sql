-- Why a document was cancelled, by whom and when, kept on the document itself
-- rather than only in the audit trail, so it shows wherever the document does.
-- A reason is required from now on (services/void-reason.ts); older voids have
-- none.
ALTER TABLE invoices
  ADD COLUMN void_reason VARCHAR(300) NULL AFTER voided_at,
  ADD COLUMN voided_by_user_id BIGINT NULL AFTER void_reason;
ALTER TABLE bills
  ADD COLUMN void_reason VARCHAR(300) NULL AFTER voided_at,
  ADD COLUMN voided_by_user_id BIGINT NULL AFTER void_reason;
ALTER TABLE payments
  ADD COLUMN voided_at DATETIME NULL,
  ADD COLUMN void_reason VARCHAR(300) NULL,
  ADD COLUMN voided_by_user_id BIGINT NULL;
ALTER TABLE credit_notes
  ADD COLUMN voided_at DATETIME NULL,
  ADD COLUMN void_reason VARCHAR(300) NULL,
  ADD COLUMN voided_by_user_id BIGINT NULL;
ALTER TABLE vendor_credits
  ADD COLUMN voided_at DATETIME NULL,
  ADD COLUMN void_reason VARCHAR(300) NULL,
  ADD COLUMN voided_by_user_id BIGINT NULL;
ALTER TABLE opening_documents
  ADD COLUMN voided_at DATETIME NULL,
  ADD COLUMN void_reason VARCHAR(300) NULL,
  ADD COLUMN voided_by_user_id BIGINT NULL;
