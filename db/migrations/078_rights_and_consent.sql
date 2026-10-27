-- Rights per voucher type, and the DPDP pieces for employees.
--
-- A voucher type can be restricted: then only admins, and custom roles given
-- it by name, may raise documents of that type.
--
-- Employee PAN is sealed at rest like bank numbers already are (crypto/fields),
-- so its column grows to hold the sealed form. Aadhaar, where a business keeps
-- it, is sealed too and shown masked. Consent is recorded per person and
-- purpose, with when it was given and when it was withdrawn: the Digital
-- Personal Data Protection Act asks for consent to be as easy to withdraw as
-- it was to give, and for the record of it.

ALTER TABLE voucher_types ADD COLUMN restricted TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE employees
  MODIFY COLUMN pan VARCHAR(160) NULL,
  ADD COLUMN aadhaar_no VARCHAR(160) NULL;

CREATE TABLE IF NOT EXISTS consents (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id               BIGINT       NOT NULL,
  subject_type         ENUM('employee','contact') NOT NULL,
  subject_id           BIGINT       NOT NULL,
  purpose              VARCHAR(60)  NOT NULL,
  -- The notice they were shown, so a later change of wording is traceable.
  notice_version       VARCHAR(20)  NOT NULL,
  given_at             TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- How it was given: signed on paper, by email, in person.
  given_by             VARCHAR(60)  NULL,
  withdrawn_at         TIMESTAMP    NULL,
  recorded_by_user_id  BIGINT       NULL,
  CONSTRAINT fk_consent_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  KEY idx_consent_subject (org_id, subject_type, subject_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
