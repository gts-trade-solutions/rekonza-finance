-- Email templates, as Zoho Books lets a business word its own emails: the
-- invoice email, the statement, payment reminders and the portal invitation,
-- each with placeholders ({customer}, {number}, {link} …) filled in when it
-- goes. A kind with no row here uses the built-in wording
-- (lib/server/mail/templates.ts), so nothing changes until someone edits one.
CREATE TABLE IF NOT EXISTS email_templates (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  kind                VARCHAR(30)   NOT NULL,
  subject             VARCHAR(300)  NOT NULL,
  body                TEXT          NOT NULL,
  updated_by_user_id  BIGINT        NULL,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_etpl_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_etpl_kind (org_id, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
