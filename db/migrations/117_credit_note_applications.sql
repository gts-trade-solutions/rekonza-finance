-- Zoho Books' "Apply to Invoices" on a credit note: the credit set against
-- one or more of the customer's open invoices, at creation or any time later.
-- Each application is kept, so voiding the credit note gives every invoice its
-- balance back, and the credit note shows where its credit went. An
-- application is an allocation, not a posting: the credit note's own entry
-- already reduced receivables.

CREATE TABLE IF NOT EXISTS credit_note_applications (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  credit_note_id     BIGINT NOT NULL,
  invoice_id         BIGINT NOT NULL,
  amount             DECIMAL(19,4) NOT NULL,
  applied_on         DATE NOT NULL,
  created_by_user_id BIGINT NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_cnapp_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_cnapp_cn FOREIGN KEY (credit_note_id) REFERENCES credit_notes(id),
  CONSTRAINT fk_cnapp_inv FOREIGN KEY (invoice_id) REFERENCES invoices(id),
  KEY idx_cnapp_cn (credit_note_id),
  KEY idx_cnapp_inv (invoice_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
