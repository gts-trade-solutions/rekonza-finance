-- 002_ledger.sql
-- Chart of accounts, the append-only journal, number series, period locks.
--
-- Money is DECIMAL(19,4) everywhere. Never FLOAT or DOUBLE: binary floating
-- point cannot represent 0.10 exactly, so a few thousand additions is all it
-- takes for a trial balance to stop tying by a paisa, and a ledger that does
-- not tie is not a ledger. mysql2 hands DECIMAL back as a string, which the
-- application converts to integer paise at the repository boundary.
--
-- Rates and quantities get DECIMAL(19,6): a 2.5% TDS rate on a part-quantity
-- needs more than two decimals before it is rounded into a money column.

CREATE TABLE IF NOT EXISTS accounts (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id        BIGINT        NOT NULL,
  code          VARCHAR(20)   NOT NULL,
  name          VARCHAR(150)  NOT NULL,
  -- The five families. Everything a report does begins by splitting on this.
  type          ENUM('asset','liability','equity','income','expense') NOT NULL,
  subtype       VARCHAR(50)   NULL,
  parent_id     BIGINT        NULL,
  description   VARCHAR(500)  NULL,
  -- System accounts are referenced by the posting engine by code. They cannot
  -- be deleted or retyped, because doing so would break every future posting.
  is_system     TINYINT(1)    NOT NULL DEFAULT 0,
  is_active     TINYINT(1)    NOT NULL DEFAULT 1,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_accounts_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_accounts_parent FOREIGN KEY (parent_id) REFERENCES accounts(id),
  UNIQUE KEY uq_accounts_org_code (org_id, code),
  KEY idx_accounts_org_type (org_id, type, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per (branch, document type, financial year). Allocation takes a row
-- lock so two people saving an invoice at the same moment cannot be handed the
-- same number — a duplicate invoice number is a GST filing failure, not a
-- cosmetic clash.
CREATE TABLE IF NOT EXISTS number_series (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id        BIGINT        NOT NULL,
  branch_id     BIGINT        NOT NULL,
  doc_type      VARCHAR(20)   NOT NULL,
  fy_label      VARCHAR(10)   NOT NULL,
  prefix        VARCHAR(30)   NOT NULL,
  next_number   INT           NOT NULL DEFAULT 1,
  padding       TINYINT       NOT NULL DEFAULT 4,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_series_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_series_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  UNIQUE KEY uq_series (org_id, branch_id, doc_type, fy_label)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only. Nothing in the application updates or deletes a posted entry;
-- a correction is a new entry that reverses the old one, which is why
-- reversal_of_entry_id exists rather than an is_deleted flag.
CREATE TABLE IF NOT EXISTS journal_entries (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id                BIGINT        NOT NULL,
  branch_id             BIGINT        NOT NULL,
  entry_no              INT           NOT NULL,
  entry_date            DATE          NOT NULL,
  memo                  VARCHAR(500)  NULL,
  -- What caused this entry: 'invoice', 'bill', 'payment', 'manual', …
  source_type           VARCHAR(30)   NOT NULL DEFAULT 'manual',
  source_id             BIGINT        NULL,
  reversal_of_entry_id  BIGINT        NULL,
  total_debit           DECIMAL(19,4) NOT NULL,
  total_credit          DECIMAL(19,4) NOT NULL,
  posted_by_user_id     BIGINT        NULL,
  posted_at             TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_je_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_je_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_je_reversal FOREIGN KEY (reversal_of_entry_id) REFERENCES journal_entries(id),
  -- The database refuses an unbalanced entry outright. The posting service
  -- checks this too, but the constraint is what makes it impossible rather
  -- than merely unlikely — including for anything that bypasses the service.
  CONSTRAINT ck_je_balanced CHECK (total_debit = total_credit),
  CONSTRAINT ck_je_nonzero  CHECK (total_debit >= 0),
  UNIQUE KEY uq_je_org_no (org_id, entry_no),
  KEY idx_je_org_date (org_id, entry_date),
  KEY idx_je_source (org_id, source_type, source_id),
  KEY idx_je_branch_date (org_id, branch_id, entry_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS journal_lines (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  entry_id      BIGINT        NOT NULL,
  org_id        BIGINT        NOT NULL,
  line_no       SMALLINT      NOT NULL,
  account_id    BIGINT        NOT NULL,
  debit         DECIMAL(19,4) NOT NULL DEFAULT 0,
  credit        DECIMAL(19,4) NOT NULL DEFAULT 0,
  description   VARCHAR(500)  NULL,
  -- Denormalised from the entry so ledger and ageing queries need no join.
  entry_date    DATE          NOT NULL,
  contact_id    BIGINT        NULL,
  CONSTRAINT fk_jl_entry FOREIGN KEY (entry_id) REFERENCES journal_entries(id),
  CONSTRAINT fk_jl_account FOREIGN KEY (account_id) REFERENCES accounts(id),
  -- A line is a debit or a credit, never both and never neither. Allowing both
  -- lets the same line be netted two different ways by two different reports.
  CONSTRAINT ck_jl_sign CHECK (debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0)),
  CONSTRAINT ck_jl_nonempty CHECK (debit > 0 OR credit > 0),
  UNIQUE KEY uq_jl_entry_line (entry_id, line_no),
  KEY idx_jl_account_date (org_id, account_id, entry_date),
  KEY idx_jl_contact (org_id, contact_id, entry_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-module period locks. Sales are usually finalised before purchases are,
-- so one blunt lock date for the whole book forces everyone to wait for the
-- slowest module.
CREATE TABLE IF NOT EXISTS transaction_locks (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id        BIGINT        NOT NULL,
  module        ENUM('sales','purchases','banking','accountant') NOT NULL,
  locked_upto   DATE          NULL,
  reason        VARCHAR(300)  NULL,
  locked_by_user_id BIGINT    NULL,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_locks_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_locks_org_module (org_id, module)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
