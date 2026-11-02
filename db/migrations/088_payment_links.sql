-- Online payment of invoices: a Razorpay payment link on an invoice, and the
-- receipt recorded by itself when the customer pays.
--
-- The merchant is the business, not Rekonza: each company connects its own
-- Razorpay account (Settings → Integrations). Its key secret and webhook
-- secret are sealed with INTEGRATION_KEY, as the GST portal credentials are,
-- and the money is booked to the account the business names for settlements —
-- usually a "Razorpay clearing" account that the bank settlement then empties.

CREATE TABLE IF NOT EXISTS payment_gateways (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id        BIGINT        NOT NULL,
  provider      ENUM('razorpay') NOT NULL DEFAULT 'razorpay',
  key_id        VARCHAR(60)   NOT NULL,
  -- {keySecret, webhookSecret}, sealed (lib/server/crypto).
  key_version   INT           NOT NULL,
  iv            VARBINARY(16) NOT NULL,
  auth_tag      VARBINARY(16) NOT NULL,
  ciphertext    VARBINARY(1024) NOT NULL,
  deposit_bank_account_id BIGINT NOT NULL,
  is_active     TINYINT(1)    NOT NULL DEFAULT 1,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_pg_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_pg_bank FOREIGN KEY (deposit_bank_account_id) REFERENCES bank_accounts(id),
  UNIQUE KEY uq_pg (org_id, provider)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS invoice_payment_links (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id        BIGINT        NOT NULL,
  invoice_id    BIGINT        NOT NULL,
  provider_link_id VARCHAR(60) NOT NULL,
  short_url     VARCHAR(300)  NOT NULL,
  amount        DECIMAL(19,4) NOT NULL,
  status        ENUM('created','paid','cancelled','expired') NOT NULL DEFAULT 'created',
  provider_payment_id VARCHAR(60) NULL,
  -- The receipt recorded when it was paid.
  payment_id    BIGINT        NULL,
  created_by_user_id BIGINT   NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at       TIMESTAMP     NULL,
  CONSTRAINT fk_ipl_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id),
  UNIQUE KEY uq_ipl_provider (provider_link_id),
  KEY idx_ipl_invoice (org_id, invoice_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
