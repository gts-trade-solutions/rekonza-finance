-- Sending documents to customers, and reminding them to pay.
--
-- A share link opens one invoice for whoever holds it, without signing in:
-- read-only, the recipient's copy, until it expires or is revoked. Only a hash
-- of the token is kept; the link itself exists in the message that carried it.
--
-- Payment reminders are queued by the scheduler on the days the book chose,
-- before and after an invoice falls due, one per invoice per stage. Each
-- carries its message and a link to the invoice. Without an email, SMS or
-- WhatsApp provider connected, a person sends them from the queue (WhatsApp
-- and email open ready-written) and marks them sent.

CREATE TABLE IF NOT EXISTS share_links (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT       NOT NULL,
  token_hash          CHAR(64)     NOT NULL,
  doc_type            ENUM('invoice') NOT NULL,
  doc_id              BIGINT       NOT NULL,
  expires_at          TIMESTAMP    NOT NULL,
  revoked_at          TIMESTAMP    NULL,
  opens               INT          NOT NULL DEFAULT 0,
  last_opened_at      TIMESTAMP    NULL,
  created_by_user_id  BIGINT       NULL,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_shrl_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_shrl_token (token_hash),
  KEY idx_shrl_doc (org_id, doc_type, doc_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payment_reminders (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id           BIGINT        NOT NULL,
  invoice_id       BIGINT        NOT NULL,
  -- Days from the due date: -3 is three days before, 7 a week after.
  stage_days       SMALLINT      NOT NULL,
  channel          ENUM('whatsapp','email','sms') NOT NULL,
  to_address       VARCHAR(200)  NULL,
  subject          VARCHAR(200)  NULL,
  message          VARCHAR(2000) NOT NULL,
  status           ENUM('queued','sent','skipped') NOT NULL DEFAULT 'queued',
  queued_on        DATE          NOT NULL,
  sent_at          TIMESTAMP     NULL,
  sent_by_user_id  BIGINT        NULL,
  CONSTRAINT fk_prem_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_prem_inv FOREIGN KEY (invoice_id) REFERENCES invoices(id),
  UNIQUE KEY uq_prem_stage (invoice_id, stage_days),
  KEY idx_prem_status (org_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
