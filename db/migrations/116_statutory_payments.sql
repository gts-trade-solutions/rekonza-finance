-- Paying the payroll dues to the government: PF to the EPFO (ECR, TRRN), ESI
-- to the ESIC (challan), Professional Tax to the state, LWF to the welfare
-- board. Each payment clears that month's payable in the ledger (Dr PF / ESI /
-- PT / LWF Payable, Cr the bank) and is kept here against the month it was for,
-- so the statutory registers can say paid, part paid or due. TDS on salary is
-- paid through the TDS challans, as before.

CREATE TABLE IF NOT EXISTS statutory_payments (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  component          ENUM('pf','esi','pt','lwf') COLLATE utf8mb4_unicode_ci NOT NULL,
  period             CHAR(7) COLLATE utf8mb4_unicode_ci NOT NULL,
  amount             DECIMAL(19,4) NOT NULL,
  paid_on            DATE NOT NULL,
  bank_account_id    BIGINT NOT NULL,
  reference          VARCHAR(60) COLLATE utf8mb4_unicode_ci NULL,
  journal_entry_id   BIGINT NULL,
  created_by_user_id BIGINT NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_statpay_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_statpay_bank FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id),
  CONSTRAINT fk_statpay_entry FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id),
  KEY idx_statpay_period (org_id, component, period)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
