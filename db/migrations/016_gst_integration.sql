-- 016_gst_integration.sql
-- The plumbing for talking to the GST portals: connections, credentials,
-- session tokens, a call log — and the address fields the government's own
-- schema demands that this app never collected.
--
-- Nothing in here calls anybody. It is the shape the integration needs so that
-- a GSP, or NIC's public sandbox, is a configuration change rather than a
-- rewrite. The existing DEMO behaviour becomes one provider among several and
-- keeps working, because the demo book must never depend on a live portal.

-- ── Part 1 · the fields the IRP and NIC insist on ───────────────────────────
--
-- Both the e-invoice schema (INV-01) and the e-way bill schema require the
-- seller's and buyer's PIN code and city as separate fields. This app has only
-- ever stored a free-text address blob and a state code, which means the very
-- first real call would fail on a field the user was never asked for. A blob
-- cannot be split reliably after the fact, so these are new columns and the
-- forms have to ask.
--
-- Nullable on purpose: existing rows have no answer, and the pre-flight check
-- names the missing field in the app rather than letting the portal reject the
-- document with an error code.

ALTER TABLE branches
  ADD COLUMN city    VARCHAR(60) NULL AFTER address,
  ADD COLUMN pincode CHAR(6)     NULL AFTER city;

ALTER TABLE contacts
  ADD COLUMN billing_city      VARCHAR(60) NULL AFTER billing_address,
  ADD COLUMN billing_pincode   CHAR(6)     NULL AFTER billing_city,
  ADD COLUMN shipping_city     VARCHAR(60) NULL AFTER shipping_address,
  ADD COLUMN shipping_pincode  CHAR(6)     NULL AFTER shipping_city;

-- ── Part 2 · one row per portal a business is connected to ──────────────────
--
-- Credentials are per GSTIN, not per business: a company registered in three
-- states creates a separate API user on each portal for each GSTIN. That is
-- six sets of credentials for a three-state business using both e-invoicing
-- and e-way bills, and it is the single step customers get stuck on. Modelling
-- it as (branch, portal) rather than hanging one blob off the organisation is
-- what makes that surface honestly in the UI.

CREATE TABLE IF NOT EXISTS integration_connections (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  -- A branch *is* a GST registration in this schema, so it is the right grain.
  branch_id         BIGINT        NOT NULL,
  portal            ENUM('einvoice','ewaybill','returns') NOT NULL,
  -- 'fake' is the built-in stand-in the demo book uses. Everything else names
  -- a real destination: 'nic_sandbox', or a GSP once one is contracted.
  provider          VARCHAR(40)   NOT NULL DEFAULT 'fake',
  -- Denormalised from the branch deliberately: credentials are bound to the
  -- GSTIN they were issued for, and if somebody edits the branch's GSTIN the
  -- stored credentials are no longer valid. Keeping a copy here is what lets
  -- the code notice that rather than silently authenticate as the wrong entity.
  gstin             CHAR(15)      NULL,
  status            ENUM('not_configured','configured','verified','failed','disabled')
                    NOT NULL DEFAULT 'not_configured',
  -- Non-secret settings only: base URL, whether the provider handles payload
  -- encryption for us, rate limits. Anything secret goes in the table below.
  config            JSON          NULL,
  last_verified_at  DATETIME      NULL,
  last_error        VARCHAR(1000) NULL,
  created_by_user_id BIGINT       NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_conn_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_conn_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  UNIQUE KEY uq_conn (branch_id, portal),
  KEY idx_conn_org (org_id, portal, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Part 3 · the secrets, in their own table ────────────────────────────────
--
-- Separate from the connection so that no ordinary query can accidentally
-- select ciphertext into a response. Reading a credential has to be a
-- deliberate join, which is exactly the friction you want here.
--
-- What is stored is the customer's own government portal API username and
-- password. That is not our secret to lose, so it is sealed with AES-256-GCM
-- under a key held outside the database, and the connection id is bound in as
-- additional authenticated data — a sealed blob copied onto another row will
-- not open.

CREATE TABLE IF NOT EXISTS integration_credentials (
  connection_id BIGINT        NOT NULL PRIMARY KEY,
  -- Which master key sealed this, so a key rotation can re-seal row by row
  -- instead of invalidating every connection at once.
  key_version   SMALLINT      NOT NULL DEFAULT 1,
  iv            VARBINARY(12) NOT NULL,
  auth_tag      VARBINARY(16) NOT NULL,
  ciphertext    BLOB          NOT NULL,
  -- Set when the customer last re-entered them. Portal passwords expire, and
  -- "when did we last get told these" is the first question when auth fails.
  rotated_at    DATETIME      NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_cred_conn FOREIGN KEY (connection_id)
    REFERENCES integration_connections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Part 4 · the six-hour session ───────────────────────────────────────────
--
-- Authenticating against the portal returns a token valid for about six hours
-- plus a session key that encrypts every payload after it. Both are secrets,
-- and both are worth caching: re-authenticating per request would trigger an
-- OTP to the taxpayer's phone every time, which is not a thing you can do to
-- somebody a hundred times a day.
--
-- One row per connection, replaced on refresh rather than appended, because
-- an expired token has no value and keeping a history of them is a liability.

CREATE TABLE IF NOT EXISTS integration_sessions (
  connection_id BIGINT        NOT NULL PRIMARY KEY,
  -- Checked before every use. Treated as expired a few minutes early, so a
  -- long call cannot start on a token that dies mid-flight.
  expires_at    DATETIME      NOT NULL,
  key_version   SMALLINT      NOT NULL DEFAULT 1,
  iv            VARBINARY(12) NOT NULL,
  auth_tag      VARBINARY(16) NOT NULL,
  ciphertext    BLOB          NOT NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sess_conn FOREIGN KEY (connection_id)
    REFERENCES integration_connections(id) ON DELETE CASCADE,
  KEY idx_sess_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Part 5 · what we sent, and what came back ───────────────────────────────
--
-- An assessment two years from now asks exactly one question about a disputed
-- invoice: what did you send the portal, when, and what did it say. If that is
-- not written down at the time it cannot be reconstructed, because the portal
-- keeps its own copy and ours is the only one that can disagree.
--
-- The payload itself is stored redacted, with a SHA-256 of the exact bytes we
-- transmitted alongside it. The digest proves what was sent without keeping a
-- second copy of the customer's commercial data in a log table.

CREATE TABLE IF NOT EXISTS integration_calls (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id          BIGINT        NOT NULL,
  connection_id   BIGINT        NULL,
  portal          ENUM('einvoice','ewaybill','returns') NOT NULL,
  provider        VARCHAR(40)   NOT NULL,
  operation       VARCHAR(40)   NOT NULL,
  -- What this call was about, so the log can be read from a document.
  reference_type  VARCHAR(30)   NULL,
  reference_id    BIGINT        NULL,
  outcome         ENUM('ok','rejected','error','timeout') NOT NULL,
  http_status     SMALLINT      NULL,
  -- The portal's own error code. Worth its own column: these are the thing you
  -- search by when the same rejection starts appearing across customers.
  error_code      VARCHAR(20)   NULL,
  error_message   VARCHAR(1000) NULL,
  duration_ms     INT           NOT NULL DEFAULT 0,
  request_digest  CHAR(64)      NULL,
  request_json    JSON          NULL,
  response_json   JSON          NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_call_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_call_conn FOREIGN KEY (connection_id)
    REFERENCES integration_connections(id) ON DELETE SET NULL,
  KEY idx_call_ref (org_id, reference_type, reference_id),
  KEY idx_call_recent (org_id, portal, created_at),
  KEY idx_call_errors (org_id, outcome, error_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Part 6 · what the portals hand back ─────────────────────────────────────
--
-- The e-invoice register already keeps the IRN, the acknowledgement and the QR
-- payload. Two things were missing.
--
-- The signed invoice is the government's own digitally signed copy of the
-- document — a JWT. It is the legal proof the invoice was registered when we
-- say it was, and it cannot be re-fetched indefinitely, so it is stored when
-- it arrives rather than looked up later.
--
-- The provider is recorded per row because a book can migrate from the demo
-- stand-in to a sandbox to a live GSP, and "which system issued this IRN" is
-- not answerable from the IRN itself.

ALTER TABLE einvoices
  ADD COLUMN provider       VARCHAR(40) NULL       AFTER status,
  ADD COLUMN signed_invoice MEDIUMTEXT  NULL       AFTER signed_qr_payload;

-- Part B — the vehicle — is what starts the validity clock, not generation.
-- A bill can be prepared the evening before and the lorry leave the next
-- morning, and the difference decides whether it has expired. Storing only
-- generated_at makes the expiry unknowable, so the moment Part B first
-- arrived is its own column.
--
-- sub_supply_type is NIC's field for *why* the goods are moving, and it is not
-- derivable from our document type: a delivery challan covers job work, own
-- use, line sales and exhibition goods, and NIC wants them told apart.
-- Values: supply, import, export, job_work, own_use, job_work_returns,
-- sales_return, exhibition, skd_ckd, line_sales, recipient_not_known, others.

ALTER TABLE eway_bills
  ADD COLUMN provider        VARCHAR(40) NULL                  AFTER status,
  ADD COLUMN sub_supply_type VARCHAR(30) NOT NULL DEFAULT 'supply' AFTER transport_mode,
  ADD COLUMN part_b_at       DATETIME    NULL                  AFTER generated_at,
  ADD COLUMN extended_count  SMALLINT    NOT NULL DEFAULT 0    AFTER valid_until;
