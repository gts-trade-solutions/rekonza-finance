-- Email sent from the app: invoices, statements, payment reminders.
--
-- Mail goes through the SMTP server named in the environment (SMTP_HOST and
-- the rest; lib/server/mail/mailer.ts) — the business's own Gmail, Zoho Mail
-- or provider account. Every message is logged here with what it was about and
-- whether the server took it, so "did they get the invoice?" has an answer and
-- a reminder is never sent twice.

CREATE TABLE IF NOT EXISTS email_log (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id       BIGINT        NOT NULL,
  doc_type     VARCHAR(30)   NULL,
  doc_id       BIGINT        NULL,
  to_address   VARCHAR(500)  NOT NULL,
  cc_address   VARCHAR(500)  NULL,
  subject      VARCHAR(300)  NOT NULL,
  status       ENUM('sent','failed') NOT NULL,
  error        VARCHAR(500)  NULL,
  message_id   VARCHAR(200)  NULL,
  sent_by_user_id BIGINT     NULL,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_email_doc (org_id, doc_type, doc_id),
  KEY idx_email_org (org_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
