-- Input tax credit taken back.
--
--   Rule 37   a supplier not paid within 180 days of the invoice: the credit on
--             the unpaid part is reversed (GSTR-3B table 4(B)(2)) and taken
--             again as it is paid (table 4(D)(1)). Held meanwhile in an asset,
--             because it is coming back.
--   Rule 42   credit on inputs and services used for both taxable and exempt
--             supplies: the exempt share, E/F of it, is reversed each month and
--             trued up after the year (table 4(B)(1)). A cost, not coming back.
--   Rule 43   the same for capital goods, a sixtieth of their credit a month
--             for five years.

CREATE TABLE IF NOT EXISTS itc_reversals (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  rule                ENUM('37','42','43','42-annual') NOT NULL,
  -- The month of the return the reversal goes in (YYYY-MM), or the year (YYYY) for the true-up.
  period              VARCHAR(7)    NOT NULL,
  bill_id             BIGINT        NULL,
  cgst                DECIMAL(19,4) NOT NULL DEFAULT 0,
  sgst                DECIMAL(19,4) NOT NULL DEFAULT 0,
  igst                DECIMAL(19,4) NOT NULL DEFAULT 0,
  cess                DECIMAL(19,4) NOT NULL DEFAULT 0,
  -- Rule 37: what was unpaid when it was reversed, and how much has come back since.
  unpaid_at_reversal  DECIMAL(19,4) NULL,
  paid_at_reversal    DECIMAL(19,4) NULL,
  reclaimed_cgst      DECIMAL(19,4) NOT NULL DEFAULT 0,
  reclaimed_sgst      DECIMAL(19,4) NOT NULL DEFAULT 0,
  reclaimed_igst      DECIMAL(19,4) NOT NULL DEFAULT 0,
  reclaimed_cess      DECIMAL(19,4) NOT NULL DEFAULT 0,
  journal_entry_id    BIGINT        NULL,
  created_by_user_id  BIGINT        NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_itcr_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_itcr_bill FOREIGN KEY (bill_id) REFERENCES bills(id),
  KEY idx_itcr_org (org_id, rule, period),
  KEY idx_itcr_bill (bill_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO accounts (org_id, code, name, type, subtype, description, is_system, is_active)
SELECT o.id, x.code, x.name, x.type, x.subtype, x.description, 1, 1
  FROM organizations o
  JOIN (
    SELECT '1360' AS code, 'ITC reversed, reclaimable on payment' AS name, 'asset' AS type, 'tax' AS subtype,
           'Credit reversed under Rule 37 because a supplier was not paid in 180 days; it comes back as they are paid' AS description
    UNION ALL SELECT '6975', 'ITC reversed on exempt supplies', 'expense', NULL,
           'The share of common credit that belongs to exempt supplies, reversed under Rules 42 and 43'
  ) x
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id AND a.code = x.code);
