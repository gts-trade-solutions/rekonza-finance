-- The composition scheme (CGST Act s.10, CGST Rules 7 and 62).
--
-- A composition dealer issues bills of supply, charges no tax, takes no input
-- credit, and pays a flat rate on turnover each quarter by CMP-08: 1% for
-- manufacturers, 1% of taxable turnover for traders, 5% for restaurants, 6%
-- for suppliers of services under s.10(2A). That tax cannot be collected from
-- buyers, so it is the dealer's own cost: Composition Tax, an expense.

ALTER TABLE organizations
  ADD COLUMN composition_category VARCHAR(20) NULL AFTER gst_filing_frequency;

CREATE TABLE IF NOT EXISTS composition_returns (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id             BIGINT        NOT NULL,
  fy                 SMALLINT      NOT NULL,
  quarter            TINYINT       NOT NULL,
  category           VARCHAR(20)   NOT NULL,
  rate_pct           DECIMAL(5,2)  NOT NULL,
  turnover           DECIMAL(19,4) NOT NULL,
  cgst               DECIMAL(19,4) NOT NULL,
  sgst               DECIMAL(19,4) NOT NULL,
  rcm_cgst           DECIMAL(19,4) NOT NULL DEFAULT 0,
  rcm_sgst           DECIMAL(19,4) NOT NULL DEFAULT 0,
  rcm_igst           DECIMAL(19,4) NOT NULL DEFAULT 0,
  rcm_cess           DECIMAL(19,4) NOT NULL DEFAULT 0,
  journal_entry_id   BIGINT        NULL,
  created_by_user_id BIGINT        NULL,
  created_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_cmpr_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_cmpr_user FOREIGN KEY (created_by_user_id) REFERENCES users(id),
  UNIQUE KEY uq_cmpr_quarter (org_id, fy, quarter)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO accounts (org_id, code, name, type, subtype, description, is_system, is_active)
SELECT o.id, '6965', 'Composition Tax', 'expense', NULL,
       'Tax paid on turnover under the composition scheme; it cannot be collected from buyers', 1, 1
  FROM organizations o
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id AND a.code = '6965');
