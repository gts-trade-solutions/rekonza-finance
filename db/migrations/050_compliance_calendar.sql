-- The compliance calendar: what is due when is worked out from the book's own
-- profile (lib/server/tax/compliance-calendar.ts); what has been done is kept
-- here, one row per obligation and period, with the date it was filed or paid
-- and its acknowledgement.

CREATE TABLE IF NOT EXISTS compliance_filings (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id             BIGINT       NOT NULL,
  -- The obligation ('gstr1', 'tds-deposit', …) and the period it is for:
  -- '2026-05' for a month, '2026-Q1' for a quarter, '2026-H1', '2026' for the
  -- financial year starting in 2026.
  item_key           VARCHAR(40)  NOT NULL,
  period             VARCHAR(10)  NOT NULL,
  done_on            DATE         NOT NULL,
  reference          VARCHAR(100) NULL,
  note               VARCHAR(300) NULL,
  created_by_user_id BIGINT       NULL,
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_cfil_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_cfil_user FOREIGN KEY (created_by_user_id) REFERENCES users(id),
  UNIQUE KEY uq_cfil_item (org_id, item_key, period)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Monthly returns, or quarterly under QRMP (aggregate turnover up to ₹5 crore).
ALTER TABLE organizations
  ADD COLUMN gst_filing_frequency ENUM('monthly','quarterly') NOT NULL DEFAULT 'monthly' AFTER gst_registration_type;
