-- 025_tax_rates.sql
-- Tax rates with the date they took effect.
--
-- Rates change, and a document is taxed at the rate in force on its own date.
-- A single current rate in the code cannot answer "what was the rate on 20
-- September 2025?", which every invoice raised before a change has to.
--
-- Each book keeps its own rows, so the business's CA can correct a rate where
-- the shipped one is wrong. A book with no rows of its own uses the rates that
-- ship with the software (lib/tax/statutory-rates.ts); the first edit copies
-- them in. Every shipped rate starts unverified and says where it came from.

-- GST and cess on an HSN or SAC code, by date. The code's own gst_rate_pct and
-- cess_rate_pct stay as the current defaults; these rows say what applied when.
CREATE TABLE IF NOT EXISTS hsn_rate_history (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id             BIGINT        NOT NULL,
  hsn_code_id        BIGINT        NOT NULL,
  effective_from     DATE          NOT NULL,
  gst_rate_pct       DECIMAL(6,3)  NOT NULL,
  cess_rate_pct      DECIMAL(6,3)  NOT NULL DEFAULT 0,
  -- The notification or reason, so the next person can check it.
  note               VARCHAR(300)  NULL,
  created_by_user_id BIGINT        NULL,
  created_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_hrh_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_hrh_code FOREIGN KEY (hsn_code_id) REFERENCES hsn_codes(id) ON DELETE CASCADE,
  UNIQUE KEY uq_hrh_code_date (hsn_code_id, effective_from),
  KEY idx_hrh_org (org_id, hsn_code_id, effective_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- TDS by nature of payment. `code` is the stable key vendors and bills carry
-- (the 1961-Act section, e.g. 194C); `act_ref` is how the Income-tax Act, 2025
-- numbers it, which returns for payments from 1 April 2026 must use.
CREATE TABLE IF NOT EXISTS tds_rates (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id               BIGINT        NOT NULL,
  code                 VARCHAR(20)   NOT NULL,
  act_ref              VARCHAR(60)   NULL,
  nature               VARCHAR(200)  NOT NULL,
  effective_from       DATE          NOT NULL,
  -- Individuals and HUFs pay a lower rate on some payments (contractors).
  rate_individual_pct  DECIMAL(6,3)  NOT NULL,
  rate_other_pct       DECIMAL(6,3)  NOT NULL,
  -- When the payee has no PAN.
  rate_no_pan_pct      DECIMAL(6,3)  NOT NULL,
  -- Either can be empty. TDS applies once a single payment exceeds the first,
  -- or the year's total to the payee exceeds the second.
  threshold_single     DECIMAL(19,4) NULL,
  threshold_annual     DECIMAL(19,4) NULL,
  -- Deducted only on what exceeds the annual threshold (purchase of goods).
  on_excess_only       TINYINT(1)    NOT NULL DEFAULT 0,
  source_url           VARCHAR(500)  NULL,
  verified_by_user_id  BIGINT        NULL,
  verified_at          DATETIME      NULL,
  created_at           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_tdsr_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_tdsr (org_id, code, effective_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- TCS by nature of goods.
CREATE TABLE IF NOT EXISTS tcs_rates (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id               BIGINT        NOT NULL,
  code                 VARCHAR(20)   NOT NULL,
  act_ref              VARCHAR(60)   NULL,
  nature               VARCHAR(200)  NOT NULL,
  effective_from       DATE          NOT NULL,
  rate_pct             DECIMAL(6,3)  NOT NULL,
  rate_no_pan_pct      DECIMAL(6,3)  NOT NULL,
  -- Collected only when the sale exceeds this, if set (a car over ₹10 lakh).
  threshold            DECIMAL(19,4) NULL,
  source_url           VARCHAR(500)  NULL,
  verified_by_user_id  BIGINT        NULL,
  verified_at          DATETIME      NULL,
  created_at           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_tcsr_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_tcsr (org_id, code, effective_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which TCS head an invoice collected under, so the return can group it.
ALTER TABLE invoices
  ADD COLUMN tcs_code VARCHAR(20) NULL AFTER tcs;
