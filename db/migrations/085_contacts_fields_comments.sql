-- Contact persons, custom fields in use, and comments on documents.
--
-- Contact persons: a customer is a company, and the invoice goes to accounts
-- payable while the order came from purchasing. Each contact holds any number
-- of people, one of them primary, each marked for whether documents go to them.
--
-- Custom fields: the definitions and values tables have been here since 007
-- and nothing used them. They are now read and written (services/custom-fields.ts);
-- `show_on_pdf` puts a field on the printed document, as Zoho does.
--
-- Comments: notes people leave on a document for each other ("customer asked
-- to hold until the 15th"). They are kept beside the audit trail, which says
-- what changed; a comment says why, or what is next, and is never edited.

CREATE TABLE IF NOT EXISTS contact_persons (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id       BIGINT        NOT NULL,
  contact_id   BIGINT        NOT NULL,
  salutation   VARCHAR(10)   NULL,
  name         VARCHAR(150)  NOT NULL,
  email        VARCHAR(190)  NULL,
  phone        VARCHAR(30)   NULL,
  designation  VARCHAR(100)  NULL,
  department   VARCHAR(100)  NULL,
  is_primary   TINYINT(1)    NOT NULL DEFAULT 0,
  -- Invoices, statements and reminders go to the people marked here.
  receives_documents TINYINT(1) NOT NULL DEFAULT 1,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_cperson_contact FOREIGN KEY (contact_id) REFERENCES contacts(id),
  KEY idx_cperson_contact (org_id, contact_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE custom_fields
  ADD COLUMN show_on_pdf TINYINT(1) NOT NULL DEFAULT 0 AFTER is_required;

CREATE TABLE IF NOT EXISTS comments (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id       BIGINT        NOT NULL,
  target_type  VARCHAR(30)   NOT NULL,
  target_id    BIGINT        NOT NULL,
  user_id      BIGINT        NULL,
  author_name  VARCHAR(150)  NOT NULL,
  body         VARCHAR(2000) NOT NULL,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_comments_target (org_id, target_type, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
