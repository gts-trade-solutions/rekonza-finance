-- What an invoice carries besides what Rule 46 requires: the logo, where to
-- pay, a UPI code to pay by, and the company's standard terms.
--
-- A bank account held only its last four digits, which is enough to recognise
-- it on a statement but not to be paid into. An account number printed on an
-- invoice is not a secret, so the full number is kept for the account chosen
-- for printing.

ALTER TABLE bank_accounts
  ADD COLUMN account_number  VARCHAR(34)  NULL AFTER account_last4,
  ADD COLUMN account_holder  VARCHAR(150) NULL AFTER account_number,
  ADD COLUMN branch_name     VARCHAR(150) NULL AFTER ifsc;

ALTER TABLE organizations
  ADD COLUMN print_bank_account_id  BIGINT       NULL AFTER logo_file_id,
  ADD COLUMN upi_id                 VARCHAR(100) NULL AFTER print_bank_account_id,
  ADD COLUMN upi_payee_name         VARCHAR(100) NULL AFTER upi_id,
  ADD COLUMN print_upi_qr           TINYINT(1)   NOT NULL DEFAULT 1 AFTER upi_payee_name,
  ADD COLUMN default_invoice_terms  TEXT         NULL AFTER print_upi_qr,
  ADD COLUMN default_invoice_notes  TEXT         NULL AFTER default_invoice_terms,
  ADD COLUMN signatory_name         VARCHAR(150) NULL AFTER default_invoice_notes,
  ADD CONSTRAINT fk_org_print_bank FOREIGN KEY (print_bank_account_id) REFERENCES bank_accounts(id) ON DELETE SET NULL;
