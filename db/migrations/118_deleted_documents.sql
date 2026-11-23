-- Edit and Delete, as Zoho Books has them, on sales documents, payments,
-- expenses and journals.
--
-- Zoho deletes a document outright. Here the document goes too, but two things
-- stay behind:
-- - GST law wants every number of a series accounted for: GSTR-1 table 13
--   reports the numbers issued and how many were cancelled. A deleted invoice's
--   number is counted there as cancelled, from this table.
-- - The auditor wants to see what was removed and by whom (Rule 3(1)): the
--   whole document as it stood is kept here, beside the audit-trail line.
-- Its posting is reversed, never erased: a journal entry cannot be deleted
-- (db/protect/tamper_proof_trail.sql).

CREATE TABLE IF NOT EXISTS deleted_documents (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  branch_id           BIGINT        NULL,
  -- invoice, debit_note, credit_note, estimate, sales_order, challan,
  -- retainer, payment_received, payment_made, expense, journal, bill …
  doc_type            VARCHAR(30)   NOT NULL,
  doc_id              BIGINT        NOT NULL,
  number              VARCHAR(60)   NULL,
  doc_date            DATE          NULL,
  total               DECIMAL(19,4) NULL,
  contact_id          BIGINT        NULL,
  -- The entry the document had posted, and the one that reversed it.
  journal_entry_id    BIGINT        NULL,
  reversal_entry_id   BIGINT        NULL,
  reason              VARCHAR(300)  NULL,
  snapshot            JSON          NOT NULL,
  deleted_by_user_id  BIGINT        NULL,
  deleted_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_deldoc_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  KEY idx_deldoc_type_date (org_id, doc_type, doc_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
