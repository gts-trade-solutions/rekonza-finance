-- Two-step sign-in: a code from an authenticator app after the password.
--
-- The secret is sealed with the field-encryption key when one is configured
-- (lib/server/crypto/fields.ts). Recovery codes are kept only as hashes, so
-- the database never holds anything that signs anyone in on its own.
-- mfa_last_step refuses a code that has already been used once.

ALTER TABLE users
  ADD COLUMN mfa_secret          VARCHAR(255) NULL,
  ADD COLUMN mfa_pending_secret  VARCHAR(255) NULL,
  ADD COLUMN mfa_enabled_at      TIMESTAMP    NULL,
  ADD COLUMN mfa_last_step       BIGINT       NULL,
  ADD COLUMN mfa_recovery_codes  JSON         NULL;

-- Between the password and the code: proof the password was right, good for
-- five minutes and five tries.
CREATE TABLE IF NOT EXISTS mfa_challenges (
  token_hash   CHAR(64)     NOT NULL PRIMARY KEY,
  user_id      BIGINT       NOT NULL,
  org_id       BIGINT       NOT NULL,
  attempts     INT          NOT NULL DEFAULT 0,
  ip           VARCHAR(64)  NULL,
  user_agent   VARCHAR(500) NULL,
  expires_at   TIMESTAMP    NOT NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_mfac_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  KEY idx_mfac_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
