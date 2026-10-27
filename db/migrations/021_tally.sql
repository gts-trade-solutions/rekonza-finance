-- 021_tally.sql
-- A company's own Tally books, read into the portal.
--
-- TallyPrime is desktop software: it answers on port 9000 of the machine it
-- runs on and nowhere else. So a small connector installed beside it reads the
-- company and pushes it out to the portal over HTTPS — nothing reaches in, no
-- port is opened on the customer's network, and nothing is ever written back
-- into Tally.
--
-- What is stored is Tally's, as Tally has it: its groups and ledgers by name,
-- its vouchers by GUID, and the closing balances Tally itself computed on the
-- day of the last sync. None of it touches this app's own ledger. A business
-- can keep its books in Tally and still see them here, and the two are never
-- mixed.
--
-- Money is integer paise, as everywhere else. A balance is signed: positive is
-- a debit, negative a credit.

-- ── Connectors ───────────────────────────────────────────────────────────────

-- One row per installed connector, which usually means one PC running Tally.
-- It starts as a pairing code shown in the portal and becomes a token once the
-- connector redeems the code. Only hashes are kept: the code is shown once, the
-- token is handed to the connector once, and neither can be read back.
CREATE TABLE IF NOT EXISTS tally_connectors (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  status              ENUM('pending','active','revoked') NOT NULL DEFAULT 'pending',
  pairing_code_hash   CHAR(64)      NULL,
  pairing_expires_at  DATETIME      NULL,
  token_hash          CHAR(64)      NULL,
  -- The first characters of the token, so a person can tell connectors apart.
  token_prefix        VARCHAR(12)   NULL,
  machine_name        VARCHAR(100)  NULL,
  connector_version   VARCHAR(30)   NULL,
  tally_version       VARCHAR(80)   NULL,
  last_seen_at        DATETIME      NULL,
  last_error          VARCHAR(500)  NULL,
  paired_at           DATETIME      NULL,
  revoked_at          DATETIME      NULL,
  created_by_user_id  BIGINT        NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_tcon_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_tcon_code (pairing_code_hash),
  UNIQUE KEY uq_tcon_token (token_hash),
  KEY idx_tcon_org (org_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Companies ────────────────────────────────────────────────────────────────

-- A Tally company, as reported by a connector. Keyed by Tally's own GUID, so a
-- company moved to another PC — and so another connector — is the same row.
CREATE TABLE IF NOT EXISTS tally_companies (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id               BIGINT        NOT NULL,
  connector_id         BIGINT        NOT NULL,
  guid                 VARCHAR(100)  NOT NULL,
  name                 VARCHAR(200)  NOT NULL,
  books_from           DATE          NULL,
  -- The start of the financial year Tally's closing balances are counted from.
  fy_from              DATE          NULL,
  gstin                VARCHAR(15)   NULL,
  state_name           VARCHAR(60)   NULL,
  maintains_inventory  TINYINT(1)    NOT NULL DEFAULT 0,
  -- The date the stored closing balances are as at.
  as_of                DATE          NULL,
  -- Tally raises an AlterID on every change. The highest one received is where
  -- the next sync resumes, so only what changed is sent again.
  voucher_alter_id     BIGINT        NOT NULL DEFAULT 0,
  master_alter_id      BIGINT        NOT NULL DEFAULT 0,
  last_synced_at       DATETIME      NULL,
  last_error           VARCHAR(500)  NULL,
  created_at           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_tcom_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_tcom_connector FOREIGN KEY (connector_id) REFERENCES tally_connectors(id),
  UNIQUE KEY uq_tcom_guid (org_id, guid),
  KEY idx_tcom_connector (connector_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Masters ──────────────────────────────────────────────────────────────────

-- Groups by name, because that is how Tally links everything: a ledger names
-- its parent group, a voucher names its ledgers. Nature and gross-profit effect
-- are Tally's own answers, inherited down the tree, so a group a customer made
-- under Direct Expenses lands in the trading account without a rule here.
CREATE TABLE IF NOT EXISTS tally_groups (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_id            BIGINT        NOT NULL,
  name                  VARCHAR(200)  NOT NULL,
  parent                VARCHAR(200)  NULL,
  nature                ENUM('assets','liabilities','income','expenses') NOT NULL,
  affects_gross_profit  TINYINT(1)    NOT NULL DEFAULT 0,
  guid                  VARCHAR(100)  NULL,
  CONSTRAINT fk_tgrp_company FOREIGN KEY (company_id) REFERENCES tally_companies(id) ON DELETE CASCADE,
  UNIQUE KEY uq_tgrp_name (company_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tally_ledgers (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_id     BIGINT        NOT NULL,
  name           VARCHAR(200)  NOT NULL,
  parent         VARCHAR(200)  NOT NULL,
  opening_paise  BIGINT        NOT NULL DEFAULT 0,
  -- As Tally computed it on companies.as_of: for an income or expense ledger,
  -- the financial year to date; for everything else, the running balance.
  closing_paise  BIGINT        NOT NULL DEFAULT 0,
  gstin          VARCHAR(15)   NULL,
  state_name     VARCHAR(60)   NULL,
  guid           VARCHAR(100)  NULL,
  CONSTRAINT fk_tled_company FOREIGN KEY (company_id) REFERENCES tally_companies(id) ON DELETE CASCADE,
  UNIQUE KEY uq_tled_name (company_id, name),
  KEY idx_tled_parent (company_id, parent)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tally_stock_items (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_id           BIGINT         NOT NULL,
  name                 VARCHAR(200)   NOT NULL,
  parent               VARCHAR(200)   NULL,
  unit                 VARCHAR(30)    NULL,
  hsn                  VARCHAR(12)    NULL,
  opening_qty          DECIMAL(18,4)  NOT NULL DEFAULT 0,
  opening_value_paise  BIGINT         NOT NULL DEFAULT 0,
  closing_qty          DECIMAL(18,4)  NOT NULL DEFAULT 0,
  closing_value_paise  BIGINT         NOT NULL DEFAULT 0,
  guid                 VARCHAR(100)   NULL,
  CONSTRAINT fk_tstk_company FOREIGN KEY (company_id) REFERENCES tally_companies(id) ON DELETE CASCADE,
  UNIQUE KEY uq_tstk_name (company_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Vouchers ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tally_vouchers (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_id     BIGINT         NOT NULL,
  guid           VARCHAR(100)   NOT NULL,
  alter_id       BIGINT         NOT NULL DEFAULT 0,
  -- As named in the company ("GST Sales"), and the predefined type it is a
  -- kind of ("Sales"), which is what the reports group by.
  voucher_type   VARCHAR(100)   NOT NULL,
  base_type      VARCHAR(40)    NOT NULL,
  number         VARCHAR(100)   NULL,
  date           DATE           NOT NULL,
  party          VARCHAR(200)   NULL,
  narration      VARCHAR(1000)  NULL,
  reference      VARCHAR(100)   NULL,
  -- The total of the debit side. Zero for a voucher that moves no money, like
  -- a sales order.
  amount_paise   BIGINT         NOT NULL DEFAULT 0,
  is_cancelled   TINYINT(1)     NOT NULL DEFAULT 0,
  is_optional    TINYINT(1)     NOT NULL DEFAULT 0,
  CONSTRAINT fk_tvch_company FOREIGN KEY (company_id) REFERENCES tally_companies(id) ON DELETE CASCADE,
  UNIQUE KEY uq_tvch_guid (company_id, guid),
  KEY idx_tvch_date (company_id, date),
  KEY idx_tvch_type (company_id, base_type, date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tally_voucher_entries (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  voucher_id    BIGINT         NOT NULL,
  company_id    BIGINT         NOT NULL,
  line_no       SMALLINT       NOT NULL,
  ledger        VARCHAR(200)   NOT NULL,
  debit_paise   BIGINT         NOT NULL DEFAULT 0,
  credit_paise  BIGINT         NOT NULL DEFAULT 0,
  CONSTRAINT fk_tent_voucher FOREIGN KEY (voucher_id) REFERENCES tally_vouchers(id) ON DELETE CASCADE,
  KEY idx_tent_ledger (company_id, ledger, voucher_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
