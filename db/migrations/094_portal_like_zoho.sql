-- The customer and vendor portal, made to work as Zoho Books' does.
--
-- Signing in by email: a customer or vendor whose portal is turned on gives
-- their email address, gets a six-digit code by email, and is let in — no
-- link to keep. Only a hash of the code is stored; it lasts ten minutes and
-- five wrong tries.
CREATE TABLE IF NOT EXISTS portal_login_codes (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  email       VARCHAR(190) NOT NULL,
  code_hash   CHAR(64)     NOT NULL,
  expires_at  TIMESTAMP    NOT NULL,
  attempts    INT          NOT NULL DEFAULT 0,
  used_at     TIMESTAMP    NULL,
  ip          VARCHAR(45)  NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_plc_email (email, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A vendor accepting or declining a purchase order from the portal.
ALTER TABLE purchase_orders
  ADD COLUMN vendor_response      ENUM('accepted','declined') NULL,
  ADD COLUMN vendor_response_note VARCHAR(500) NULL,
  ADD COLUMN vendor_response_at   TIMESTAMP    NULL;

-- Changes a portal user asks for that the business must approve first. Bank
-- details above all: a changed account number is the oldest way of stealing
-- a supplier's payment, so it is never applied without someone checking it.
CREATE TABLE IF NOT EXISTS portal_requests (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  contact_id          BIGINT        NOT NULL,
  kind                ENUM('bank_details') NOT NULL,
  -- Sealed where it holds an account number (lib/server/crypto/fields.ts).
  payload             JSON          NOT NULL,
  status              ENUM('pending','applied','rejected') NOT NULL DEFAULT 'pending',
  decided_by_user_id  BIGINT        NULL,
  decided_at          TIMESTAMP     NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_portalreq_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_portalreq_contact FOREIGN KEY (contact_id) REFERENCES contacts(id),
  KEY idx_preq_open (org_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- What portal users did: Zoho's "Portal activities" report.
CREATE TABLE IF NOT EXISTS portal_activity (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id       BIGINT        NOT NULL,
  contact_id   BIGINT        NOT NULL,
  side         ENUM('customer','vendor') NOT NULL,
  action       VARCHAR(40)   NOT NULL,
  target_type  VARCHAR(30)   NULL,
  target_id    BIGINT        NULL,
  detail       VARCHAR(300)  NULL,
  ip           VARCHAR(45)   NULL,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pact_org (org_id, created_at),
  KEY idx_pact_contact (org_id, contact_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
