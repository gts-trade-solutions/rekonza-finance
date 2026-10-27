-- Personal data: sealed at rest, and the Digital Personal Data Protection Act's
-- duties to the people it is about.
--
-- Bank account numbers are sealed with the field-encryption key when one is
-- set (lib/server/crypto/fields.ts); a sealed value is longer than the number,
-- so the columns widen.

ALTER TABLE contacts            MODIFY COLUMN bank_account_no VARCHAR(160) NULL;
ALTER TABLE employees           MODIFY COLUMN bank_account_no VARCHAR(160) NULL;
ALTER TABLE payment_batch_lines MODIFY COLUMN account_no      VARCHAR(160) NULL;

-- What people ask of the book about their own data: to see it, correct it,
-- erase it, withdraw consent, or complain. Each has a date by which it is
-- answered, and the answer is kept.
CREATE TABLE IF NOT EXISTS privacy_requests (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id               BIGINT        NOT NULL,
  subject_type         ENUM('contact','employee','user','other') NOT NULL,
  subject_id           BIGINT        NULL,
  subject_name         VARCHAR(200)  NOT NULL,
  kind                 ENUM('access','correction','erasure','grievance','consent_withdrawal') NOT NULL,
  details              VARCHAR(1000) NULL,
  received_on          DATE          NOT NULL,
  due_on               DATE          NOT NULL,
  status               ENUM('open','done','refused') NOT NULL DEFAULT 'open',
  response             VARCHAR(2000) NULL,
  handled_by_user_id   BIGINT        NULL,
  closed_at            TIMESTAMP     NULL,
  created_by_user_id   BIGINT        NULL,
  created_at           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_preq_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  KEY idx_preq_open (org_id, status, due_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Breaches of personal data, and when the Board and the people affected were told.
CREATE TABLE IF NOT EXISTS privacy_breaches (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id               BIGINT        NOT NULL,
  discovered_at        TIMESTAMP     NOT NULL,
  description          VARCHAR(2000) NOT NULL,
  data_affected        VARCHAR(500)  NULL,
  people_affected      INT           NULL,
  board_informed_at    TIMESTAMP     NULL,
  board_report_at      TIMESTAMP     NULL,
  people_informed_at   TIMESTAMP     NULL,
  measures             VARCHAR(2000) NULL,
  created_by_user_id   BIGINT        NULL,
  created_at           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pbr_org FOREIGN KEY (org_id) REFERENCES organizations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- An erased contact keeps its documents (the tax laws require them) under a
-- name that no longer identifies anyone.
ALTER TABLE contacts ADD COLUMN erased_at TIMESTAMP NULL;
