-- Filing GST returns through the GST system's API, as Zoho Books does once a
-- GSTIN is connected: push GSTR-1 / IFF / GSTR-3B to the portal, follow what
-- the portal made of it, file with EVC and keep the ARN.
--
-- The connection, credentials and six-hour session already live in the
-- integration tables (016), under portal 'returns'. What was missing is the
-- record of each return sent: when, by whom, the reference the portal gave,
-- what it reported back (its error report, line by line, when it refused
-- part of it), and the ARN once filed. A return is a statement to the
-- government; what was sent and what came back has to be answerable later.

CREATE TABLE IF NOT EXISTS gst_return_submissions (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id             BIGINT        NOT NULL,
  branch_id          BIGINT        NOT NULL,
  gstin              CHAR(15)      NOT NULL,
  return_type        ENUM('GSTR1','IFF','GSTR3B') NOT NULL,
  -- MMYYYY, the portal's own form; the quarter's last month for a quarterly return.
  ret_period         CHAR(6)       NOT NULL,
  action             ENUM('save','file') NOT NULL,
  provider           VARCHAR(40)   NOT NULL,
  -- The portal's reference for a save, which its status is asked by.
  reference_id       VARCHAR(60)   NULL,
  status             ENUM('pending','processed','processed_with_errors','error','filed') NOT NULL DEFAULT 'pending',
  -- What the portal said: its error report for a save, its message for a refusal.
  portal_message     VARCHAR(1000) NULL,
  error_report       JSON          NULL,
  arn                VARCHAR(20)   NULL,
  filed_at           DATETIME      NULL,
  -- SHA-256 of exactly what was sent, so the return can be proved without a copy.
  payload_digest     CHAR(64)      NULL,
  -- The figures it carried, for the screen: taxable value and tax, in rupees.
  totals             JSON          NULL,
  created_by_user_id BIGINT        NULL,
  created_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_grs_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_grs_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  KEY idx_grs_period (org_id, branch_id, return_type, ret_period, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
