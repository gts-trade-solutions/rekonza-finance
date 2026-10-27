-- 007_gst_platform.sql
-- E-invoice register, e-way bills, GSTR-2B, and the platform tables:
-- files, jobs, settings, custom fields, approvals, recurring profiles.

-- The IRN is issued by the Invoice Registration Portal. A B2B invoice above
-- the turnover threshold is not legally valid without one, and there is a
-- 30-day window from the invoice date to report it. Failures are kept, not
-- overwritten, because the retry history is what an assessment asks about.
CREATE TABLE IF NOT EXISTS einvoices (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  invoice_id        BIGINT        NOT NULL,
  status            ENUM('not_applicable','pending','submitted','failed','cancelled') NOT NULL DEFAULT 'pending',
  irn               CHAR(64)      NULL,
  ack_no            VARCHAR(30)   NULL,
  ack_date          DATETIME      NULL,
  signed_qr_payload MEDIUMTEXT    NULL,
  error_code        VARCHAR(20)   NULL,
  error_message     VARCHAR(1000) NULL,
  attempts          SMALLINT      NOT NULL DEFAULT 0,
  cancelled_at      DATETIME      NULL,
  cancel_reason     VARCHAR(200)  NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_einv_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_einv_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  UNIQUE KEY uq_einv_invoice (invoice_id),
  UNIQUE KEY uq_einv_irn (irn),
  KEY idx_einv_status (org_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS eway_bills (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  invoice_id        BIGINT        NULL,
  challan_id        BIGINT        NULL,
  eway_bill_no      VARCHAR(20)   NULL,
  status            ENUM('pending','generated','cancelled','expired') NOT NULL DEFAULT 'pending',
  transport_mode    ENUM('road','rail','air','ship') NOT NULL DEFAULT 'road',
  vehicle_no        VARCHAR(20)   NULL,
  transporter_id    VARCHAR(20)   NULL,
  transporter_name  VARCHAR(150)  NULL,
  distance_km       INT           NULL,
  from_pincode      CHAR(6)       NULL,
  to_pincode        CHAR(6)       NULL,
  generated_at      DATETIME      NULL,
  valid_until       DATETIME      NULL,
  error_message     VARCHAR(1000) NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_ewb_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_ewb_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id),
  CONSTRAINT fk_ewb_challan FOREIGN KEY (challan_id) REFERENCES delivery_challans(id),
  UNIQUE KEY uq_ewb_no (eway_bill_no),
  KEY idx_ewb_org (org_id, status, valid_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- GSTR-2B is the government's monthly statement of the input credit available
-- to us. Credit claimed in our books but absent here will be reversed with
-- interest, so the two have to be reconciled every month.
CREATE TABLE IF NOT EXISTS gstr2b_entries (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  return_period     CHAR(6)       NOT NULL,
  vendor_gstin      CHAR(15)      NOT NULL,
  vendor_name       VARCHAR(200)  NULL,
  invoice_no        VARCHAR(60)   NOT NULL,
  invoice_date      DATE          NOT NULL,
  taxable           DECIMAL(19,4) NOT NULL DEFAULT 0,
  cgst              DECIMAL(19,4) NOT NULL DEFAULT 0,
  sgst              DECIMAL(19,4) NOT NULL DEFAULT 0,
  igst              DECIMAL(19,4) NOT NULL DEFAULT 0,
  cess              DECIMAL(19,4) NOT NULL DEFAULT 0,
  itc_available     TINYINT(1)    NOT NULL DEFAULT 1,
  matched_bill_id   BIGINT        NULL,
  match_status      ENUM('unmatched','matched','mismatch','missing_in_books') NOT NULL DEFAULT 'unmatched',
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_2b_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_2b_bill FOREIGN KEY (matched_bill_id) REFERENCES bills(id),
  UNIQUE KEY uq_2b (org_id, return_period, vendor_gstin, invoice_no),
  KEY idx_2b_period (org_id, return_period, match_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Attachments live in object storage; this table is the index. Only the key is
-- stored, never the bytes, so the database stays small enough to restore fast.
CREATE TABLE IF NOT EXISTS files (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  storage_key       VARCHAR(500)  NOT NULL,
  filename          VARCHAR(255)  NOT NULL,
  content_type      VARCHAR(120)  NOT NULL,
  size_bytes        BIGINT        NOT NULL DEFAULT 0,
  checksum_sha256   CHAR(64)      NULL,
  attached_to_type  VARCHAR(30)   NULL,
  attached_to_id    BIGINT        NULL,
  uploaded_by_user_id BIGINT      NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_files_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_files_key (storage_key),
  KEY idx_files_attached (org_id, attached_to_type, attached_to_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Database-backed queue, following the email-app pattern. A table survives a
-- restart; an in-process queue does not, and a dropped e-invoice submission is
-- a compliance failure rather than a lost email.
CREATE TABLE IF NOT EXISTS jobs (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  kind              VARCHAR(50)   NOT NULL,
  payload           JSON          NOT NULL,
  status            ENUM('queued','running','completed','failed','cancelled') NOT NULL DEFAULT 'queued',
  priority          SMALLINT      NOT NULL DEFAULT 100,
  attempts          SMALLINT      NOT NULL DEFAULT 0,
  max_attempts      SMALLINT      NOT NULL DEFAULT 3,
  run_after         DATETIME      NULL,
  -- Claimed by a worker with an UPDATE ... WHERE status='queued', so two
  -- workers cannot pick up the same row.
  locked_by         VARCHAR(64)   NULL,
  locked_at         DATETIME      NULL,
  started_at        DATETIME      NULL,
  finished_at       DATETIME      NULL,
  last_error        TEXT          NULL,
  result            JSON          NULL,
  created_by_user_id BIGINT       NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_jobs_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  KEY idx_jobs_claim (status, run_after, priority),
  KEY idx_jobs_org_kind (org_id, kind, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS settings (
  org_id        BIGINT        NOT NULL,
  scope         VARCHAR(40)   NOT NULL,
  setting_key   VARCHAR(80)   NOT NULL,
  value         JSON          NOT NULL,
  updated_by_user_id BIGINT   NULL,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id, scope, setting_key),
  CONSTRAINT fk_settings_org FOREIGN KEY (org_id) REFERENCES organizations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS custom_fields (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id        BIGINT        NOT NULL,
  entity        VARCHAR(30)   NOT NULL,
  label         VARCHAR(100)  NOT NULL,
  field_key     VARCHAR(60)   NOT NULL,
  data_type     ENUM('text','number','date','select','checkbox') NOT NULL DEFAULT 'text',
  options       JSON          NULL,
  is_required   TINYINT(1)    NOT NULL DEFAULT 0,
  display_order SMALLINT      NOT NULL DEFAULT 0,
  is_active     TINYINT(1)    NOT NULL DEFAULT 1,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_cf_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_cf (org_id, entity, field_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS custom_field_values (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id        BIGINT        NOT NULL,
  field_id      BIGINT        NOT NULL,
  entity_id     BIGINT        NOT NULL,
  value         VARCHAR(1000) NULL,
  CONSTRAINT fk_cfv_field FOREIGN KEY (field_id) REFERENCES custom_fields(id) ON DELETE CASCADE,
  UNIQUE KEY uq_cfv (field_id, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS approval_rules (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  document_type     VARCHAR(30)   NOT NULL,
  threshold_amount  DECIMAL(19,4) NOT NULL DEFAULT 0,
  approver_role     ENUM('admin','accountant','sales','purchase','viewer') NOT NULL DEFAULT 'admin',
  is_active         TINYINT(1)    NOT NULL DEFAULT 1,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_appr_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  KEY idx_appr_org (org_id, document_type, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS workflow_rules (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id        BIGINT        NOT NULL,
  name          VARCHAR(150)  NOT NULL,
  trigger_event VARCHAR(60)   NOT NULL,
  conditions    JSON          NULL,
  actions       JSON          NOT NULL,
  is_active     TINYINT(1)    NOT NULL DEFAULT 1,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_wf_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  KEY idx_wf_org (org_id, trigger_event, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Entries that repeat unchanged: depreciation, prepaid amortisation, accruals.
CREATE TABLE IF NOT EXISTS recurring_journals (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  branch_id         BIGINT        NOT NULL,
  name              VARCHAR(200)  NOT NULL,
  frequency         ENUM('monthly','quarterly','yearly') NOT NULL DEFAULT 'monthly',
  next_run          DATE          NOT NULL,
  end_date          DATE          NULL,
  debit_account_id  BIGINT        NOT NULL,
  credit_account_id BIGINT        NOT NULL,
  amount            DECIMAL(19,4) NOT NULL,
  memo              VARCHAR(500)  NULL,
  is_active         TINYINT(1)    NOT NULL DEFAULT 1,
  last_posted_at    DATE          NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_rj_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_rj_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_rj_debit FOREIGN KEY (debit_account_id) REFERENCES accounts(id),
  CONSTRAINT fk_rj_credit FOREIGN KEY (credit_account_id) REFERENCES accounts(id),
  CONSTRAINT ck_rj_distinct CHECK (debit_account_id <> credit_account_id),
  KEY idx_rj_due (org_id, is_active, next_run)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS recurring_invoices (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  branch_id         BIGINT        NOT NULL,
  profile_name      VARCHAR(200)  NOT NULL,
  customer_id       BIGINT        NOT NULL,
  frequency         ENUM('weekly','monthly','quarterly','yearly') NOT NULL DEFAULT 'monthly',
  start_date        DATE          NOT NULL,
  end_date          DATE          NULL,
  next_run          DATE          NOT NULL,
  payment_terms     VARCHAR(20)   NULL,
  -- The line template, stored as written. Resolving items at generation time
  -- would silently re-price historical profiles when a catalogue price moves.
  template          JSON          NOT NULL,
  auto_send         TINYINT(1)    NOT NULL DEFAULT 0,
  is_active         TINYINT(1)    NOT NULL DEFAULT 1,
  last_generated_at DATE          NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_ri_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_ri_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_ri_customer FOREIGN KEY (customer_id) REFERENCES contacts(id),
  KEY idx_ri_due (org_id, is_active, next_run)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS api_tokens (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id        BIGINT        NOT NULL,
  name          VARCHAR(150)  NOT NULL,
  -- Only the hash is kept. The token is shown once, at creation, and cannot
  -- be recovered afterwards.
  token_hash    CHAR(64)      NOT NULL,
  token_prefix  CHAR(8)       NOT NULL,
  scopes        JSON          NOT NULL,
  last_used_at  DATETIME      NULL,
  expires_at    DATETIME      NULL,
  revoked_at    DATETIME      NULL,
  created_by_user_id BIGINT   NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_tok_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_tok_hash (token_hash),
  KEY idx_tok_org (org_id, revoked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
