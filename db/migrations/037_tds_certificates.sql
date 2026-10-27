-- TDS certificates, lower-deduction certificates, and whether a PAN works.
--
-- A deductee can hold a certificate from the Assessing Officer allowing TDS at
-- a lower rate (or nil) up to an amount, for a period (section 197 of the 1961
-- Act; section 395 of the 2025 Act). Deducting the normal rate anyway is not a
-- default, but the vendor will chase it; deducting less without one is. So the
-- certificate is kept, applied to bills dated inside it until its amount runs
-- out, and quoted in the quarterly return.
--
-- A PAN that is not linked to Aadhaar is inoperative, and TDS on it is at the
-- higher no-PAN rate (CBDT circular 3/2023). Whether a PAN is operative is
-- checked on the e-filing portal; the result is recorded here.
--
-- Certificates to deductees (Form 131, earlier 16A) are downloaded from TRACES,
-- never made by the deductor's software. What the books need is to know which
-- are due, which were sent, and — the other way round — which certificates
-- customers have sent for the TDS they withheld from us.

ALTER TABLE contacts
  ADD COLUMN pan_status ENUM('unverified','operative','inoperative') NOT NULL DEFAULT 'unverified' AFTER pan,
  ADD COLUMN pan_checked_on DATE NULL AFTER pan_status;

CREATE TABLE IF NOT EXISTS tds_lower_certificates (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id             BIGINT        NOT NULL,
  contact_id         BIGINT        NOT NULL,
  section_code       VARCHAR(10)   NOT NULL,
  certificate_no     VARCHAR(20)   NOT NULL,
  rate_pct           DECIMAL(6,3)  NOT NULL,
  valid_from         DATE          NOT NULL,
  valid_to           DATE          NOT NULL,
  -- The most the certificate covers. NULL when it names no limit.
  amount_limit       DECIMAL(19,4) NULL,
  is_cancelled       TINYINT(1)    NOT NULL DEFAULT 0,
  notes              VARCHAR(300)  NULL,
  created_by_user_id BIGINT        NULL,
  created_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_tlc_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_tlc_contact FOREIGN KEY (contact_id) REFERENCES contacts(id),
  CONSTRAINT ck_tlc_dates CHECK (valid_to >= valid_from),
  CONSTRAINT ck_tlc_rate CHECK (rate_pct >= 0 AND rate_pct <= 100),
  UNIQUE KEY uq_tlc_no (org_id, certificate_no),
  KEY idx_tlc_lookup (org_id, contact_id, section_code, valid_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- What a bill was actually deducted at, and under which certificate.
ALTER TABLE bills
  ADD COLUMN tds_rate_pct DECIMAL(6,3) NULL AFTER tds_section,
  ADD COLUMN tds_lower_cert_id BIGINT NULL AFTER tds_rate_pct,
  ADD CONSTRAINT fk_bill_tds_cert FOREIGN KEY (tds_lower_cert_id) REFERENCES tds_lower_certificates(id);

CREATE TABLE IF NOT EXISTS tds_certificates (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id             BIGINT        NOT NULL,
  -- issued: we deducted, and sent the deductee their TRACES certificate.
  -- received: a customer deducted from us, and sent theirs.
  direction          ENUM('issued','received') NOT NULL,
  contact_id         BIGINT        NOT NULL,
  -- The financial year by its starting calendar year, and the quarter 1–4.
  fy                 SMALLINT      NOT NULL,
  quarter            TINYINT       NOT NULL,
  form               VARCHAR(20)   NOT NULL,
  certificate_no     VARCHAR(30)   NOT NULL,
  issued_on          DATE          NOT NULL,
  tax                DECIMAL(19,4) NOT NULL DEFAULT 0,
  file_id            BIGINT        NULL,
  notes              VARCHAR(300)  NULL,
  created_by_user_id BIGINT        NULL,
  created_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_tdscert_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_tdscert_contact FOREIGN KEY (contact_id) REFERENCES contacts(id),
  CONSTRAINT fk_tdscert_file FOREIGN KEY (file_id) REFERENCES files(id),
  CONSTRAINT ck_tdscert_q CHECK (quarter BETWEEN 1 AND 4),
  UNIQUE KEY uq_tdscert (org_id, direction, contact_id, fy, quarter, certificate_no),
  KEY idx_tdscert_period (org_id, direction, fy, quarter)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
