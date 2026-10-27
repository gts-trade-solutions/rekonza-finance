-- 027_tds_returns.sql
-- Depositing TDS and TCS, and the quarterly returns that report it.
--
-- Tax deducted from a supplier is owed to the government by the 7th of the
-- next month (30 April for March), paid by challan, and reported each quarter
-- with the challan that paid it. Each deduction in the return must name its
-- challan, so the challans are kept here: the bank's BSR code, the date and
-- the serial number are what the return and TRACES match on.

-- The deductor's TAN. Every TDS return and challan is filed under it.
ALTER TABLE organizations
  ADD COLUMN tan CHAR(10) NULL AFTER pan;

CREATE TABLE IF NOT EXISTS tds_challans (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id             BIGINT        NOT NULL,
  kind               ENUM('tds','tcs') NOT NULL DEFAULT 'tds',
  -- The month whose deductions this deposit pays for, yyyy-mm.
  for_month          CHAR(7)       NOT NULL,
  challan_date       DATE          NOT NULL,
  bsr_code           CHAR(7)       NOT NULL,
  challan_serial     VARCHAR(5)    NOT NULL,
  tax                DECIMAL(19,4) NOT NULL DEFAULT 0,
  -- Interest for late deduction or deposit, and the late-filing fee.
  interest           DECIMAL(19,4) NOT NULL DEFAULT 0,
  fee                DECIMAL(19,4) NOT NULL DEFAULT 0,
  total              DECIMAL(19,4) NOT NULL,
  bank_account_id    BIGINT        NULL,
  journal_entry_id   BIGINT        NULL,
  notes              VARCHAR(300)  NULL,
  created_by_user_id BIGINT        NULL,
  created_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_tdsc_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_tdsc_bank FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id),
  CONSTRAINT fk_tdsc_je FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id),
  CONSTRAINT ck_tdsc_total CHECK (total = tax + interest + fee),
  UNIQUE KEY uq_tdsc (org_id, bsr_code, challan_date, challan_serial),
  KEY idx_tdsc_month (org_id, kind, for_month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Interest and fees on late tax are a cost, and not an allowable one, so they
-- get a ledger of their own rather than hiding in bank charges.
INSERT INTO accounts (org_id, code, name, type, subtype, description, is_system, is_active)
SELECT o.id, '6960', 'Interest & Fees on Late Taxes', 'expense', NULL,
       'Interest and late fees on TDS, TCS and GST; not deductible for income tax', 1, 1
  FROM organizations o
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id AND a.code = '6960');
