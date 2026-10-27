-- Tally vouchers brought into the books.
--
-- The connector mirrors a Tally company's vouchers for the Tally reports; this
-- records which of them have also been posted here, as journal entries, so a
-- second run brings in only what is new and nothing twice.

CREATE TABLE IF NOT EXISTS tally_voucher_imports (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT       NOT NULL,
  company_id        BIGINT       NOT NULL,
  guid              VARCHAR(100) NOT NULL,
  journal_entry_id  BIGINT       NOT NULL,
  imported_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_tvi_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_tvi_entry FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id),
  UNIQUE KEY uq_tvi_guid (org_id, company_id, guid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
