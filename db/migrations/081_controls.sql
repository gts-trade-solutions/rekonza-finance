-- Internal controls, after an auditor's review of the software.
--
-- The review found the books right but the controls around them thin: problems
-- were shown on screens but nobody owned them, nothing chased them, changes
-- recorded who and when but not why, and errors went to a console nobody reads.
-- This adds the tables those controls keep their records in.

-- Why a change was made, beside who made it and when (Companies (Accounts)
-- Rules 3(1): the edit log). Filled from the reason the person gave.
ALTER TABLE audit_log
  ADD COLUMN reason VARCHAR(500) NULL AFTER detail;

-- Exceptions: something wrong that a person has to deal with — an invoice still
-- without its IRN, a customer far past due, an MSME bill nearing day 45. Found
-- by the scheduler, given an owner and a date to deal with it by, escalated if
-- that date passes, and closed with a resolution, or by itself when the
-- condition goes away. One open row per thing: `open_key` is set while it is
-- open and cleared when it closes, so the unique key allows any number of
-- closed ones beside it.
CREATE TABLE IF NOT EXISTS exceptions (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id             BIGINT        NOT NULL,
  kind               VARCHAR(40)   NOT NULL,
  subject_type       VARCHAR(30)   NOT NULL,
  subject_id         BIGINT        NOT NULL DEFAULT 0,
  title              VARCHAR(200)  NOT NULL,
  detail             VARCHAR(1000) NULL,
  severity           ENUM('low','medium','high','critical') NOT NULL DEFAULT 'medium',
  amount             DECIMAL(19,4) NULL,
  href               VARCHAR(300)  NULL,
  status             ENUM('open','in_progress','resolved','waived') NOT NULL DEFAULT 'open',
  open_key           VARCHAR(120)  NULL,
  owner_user_id      BIGINT        NULL,
  detected_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  due_at             TIMESTAMP     NULL,
  escalation_level   TINYINT       NOT NULL DEFAULT 0,
  escalated_at       TIMESTAMP     NULL,
  closed_at          TIMESTAMP     NULL,
  closed_by_user_id  BIGINT        NULL,
  resolution         VARCHAR(500)  NULL,
  CONSTRAINT fk_exc_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_exc_open (org_id, open_key),
  KEY idx_exc_status (org_id, status, severity),
  KEY idx_exc_owner (org_id, owner_user_id, status),
  KEY idx_exc_subject (org_id, subject_type, subject_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Everything that happened to an exception: raised, assigned, a note, escalated, closed.
CREATE TABLE IF NOT EXISTS exception_events (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id        BIGINT       NOT NULL,
  exception_id  BIGINT       NOT NULL,
  user_id       BIGINT       NULL,
  action        VARCHAR(20)  NOT NULL,
  note          VARCHAR(1000) NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_exce_exc FOREIGN KEY (exception_id) REFERENCES exceptions(id) ON DELETE CASCADE,
  KEY idx_exce_exc (exception_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Errors the server did not expect, kept so someone can find the cause and
-- record the fix. One row per kind of error (the fingerprint), counting how
-- often it happened; `ref` is the code the person who met it was shown.
CREATE TABLE IF NOT EXISTS error_events (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id               BIGINT        NULL,
  fingerprint          CHAR(16)      NOT NULL,
  ref                  CHAR(8)       NOT NULL,
  method               VARCHAR(10)   NULL,
  path                 VARCHAR(255)  NULL,
  error_name           VARCHAR(100)  NULL,
  message              VARCHAR(1000) NULL,
  stack                TEXT          NULL,
  last_user_id         BIGINT        NULL,
  occurrences          INT           NOT NULL DEFAULT 1,
  first_seen_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status               ENUM('open','investigating','resolved') NOT NULL DEFAULT 'open',
  root_cause           VARCHAR(500)  NULL,
  resolution           VARCHAR(500)  NULL,
  resolved_by_user_id  BIGINT        NULL,
  resolved_at          TIMESTAMP     NULL,
  UNIQUE KEY uq_err_fp (fingerprint),
  UNIQUE KEY uq_err_ref (ref),
  KEY idx_err_org (org_id, status, last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Password rules: the ones a user may not reuse, and when the current one was set.
CREATE TABLE IF NOT EXISTS password_history (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id        BIGINT       NOT NULL,
  password_hash  VARCHAR(255) NOT NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pwh_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  KEY idx_pwh_user (user_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE users
  ADD COLUMN password_changed_at TIMESTAMP NULL;

-- Who looks after a customer's account: their overdue invoices are that person's to chase.
ALTER TABLE contacts
  ADD COLUMN owner_user_id BIGINT NULL;

-- The document library: contracts, agreements, certificates and licences that
-- belong to the business rather than to one voucher. The files themselves are
-- rows in `files`, attached to type 'document'.
CREATE TABLE IF NOT EXISTS documents (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  title               VARCHAR(200)  NOT NULL,
  category            ENUM('contract','agreement','certificate','licence','policy','statutory','other') NOT NULL DEFAULT 'other',
  contact_id          BIGINT        NULL,
  reference           VARCHAR(100)  NULL,
  issued_on           DATE          NULL,
  expires_on          DATE          NULL,
  notes               VARCHAR(1000) NULL,
  created_by_user_id  BIGINT        NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  archived_at         TIMESTAMP     NULL,
  CONSTRAINT fk_doc_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  KEY idx_doc_org (org_id, category, expires_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
