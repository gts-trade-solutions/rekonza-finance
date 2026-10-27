-- The open API: keys for other software to call the same endpoints the app
-- uses, and webhooks to tell it when something happens.
--
-- A key is shown once and kept only as its SHA-256; it acts with a role, a
-- custom one if given, and in the name of the admin who made it — so it stops
-- working if that admin is switched off.
--
-- A webhook delivery is written in the same transaction as the change it
-- reports (an outbox), so a delivery is never sent for something that was
-- rolled back, nor lost for something that was not.

CREATE TABLE IF NOT EXISTS api_keys (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT       NOT NULL,
  name                VARCHAR(80)  NOT NULL,
  prefix              VARCHAR(16)  NOT NULL,
  key_hash            CHAR(64)     NOT NULL,
  role                ENUM('admin','accountant','sales','staff','viewer') NOT NULL,
  custom_role_id      BIGINT       NULL,
  created_by_user_id  BIGINT       NOT NULL,
  expires_on          DATE         NULL,
  last_used_at        TIMESTAMP    NULL,
  revoked_at          TIMESTAMP    NULL,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_apik_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_apik_user FOREIGN KEY (created_by_user_id) REFERENCES users(id),
  CONSTRAINT fk_apik_crole FOREIGN KEY (custom_role_id) REFERENCES custom_roles(id),
  UNIQUE KEY uq_apik_hash (key_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS webhooks (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT       NOT NULL,
  url                 VARCHAR(500) NOT NULL,
  events              JSON         NOT NULL,
  secret              VARCHAR(160) NOT NULL,
  description         VARCHAR(200) NULL,
  is_active           TINYINT(1)   NOT NULL DEFAULT 1,
  created_by_user_id  BIGINT       NULL,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_whk_org FOREIGN KEY (org_id) REFERENCES organizations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  webhook_id          BIGINT       NOT NULL,
  org_id              BIGINT       NOT NULL,
  event               VARCHAR(60)  NOT NULL,
  payload             JSON         NOT NULL,
  status              ENUM('pending','delivered','failed') NOT NULL DEFAULT 'pending',
  attempts            INT          NOT NULL DEFAULT 0,
  next_attempt_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  response_code       INT          NULL,
  last_error          VARCHAR(500) NULL,
  delivered_at        TIMESTAMP    NULL,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_whd_hook FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE,
  KEY idx_whd_due (status, next_attempt_at),
  KEY idx_whd_hook (webhook_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
