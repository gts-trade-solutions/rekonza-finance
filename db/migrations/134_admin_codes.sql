-- Admin codes: a one-time code an admin gives a person before they undo or
-- change posted work (the client, 2026-11-28: "once the user reversed, an OTP
-- should go to admin, and when they enter it, that time the user's reversal
-- goes through"; "if they need a modification in an invoice they need approval
-- from admin").
--
-- One row per request for a code. The code itself is not kept: only its hash,
-- so reading this table gives nobody a working code (the admins read theirs in
-- their notifications). A code belongs to one person and one action (`scope`:
-- the request it was asked for), works once, and lapses after ten minutes or
-- five wrong tries (lib/server/services/admin-codes.ts).
CREATE TABLE IF NOT EXISTS admin_codes (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  requested_by_user_id BIGINT       NOT NULL,
  -- 'undo' (reverse, void, delete, uncategorise) or 'invoice_edit'.
  kind                VARCHAR(20)   NOT NULL,
  -- The request the code is for: method, path and action, hashed.
  scope               CHAR(64)      NOT NULL,
  -- In words, as the admins were told: "delete invoice INV/26-27/0003".
  label               VARCHAR(200)  NOT NULL,
  code_hash           CHAR(64)      NOT NULL,
  attempts            INT           NOT NULL DEFAULT 0,
  expires_at          DATETIME      NOT NULL,
  used_at             DATETIME      NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_admcode_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  KEY idx_admcode_user (org_id, requested_by_user_id, scope, used_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
