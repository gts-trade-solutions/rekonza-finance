-- More than one address for a customer or vendor, as Zoho Books keeps them:
-- the branches and godowns a customer takes delivery at, each with its state
-- (and GSTIN, when the site is registered on its own), picked as the ship-to
-- on an invoice instead of typed out each time.
CREATE TABLE IF NOT EXISTS contact_addresses (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id       BIGINT        NOT NULL,
  contact_id   BIGINT        NOT NULL,
  label        VARCHAR(80)   NOT NULL,
  name         VARCHAR(150)  NULL,
  address      VARCHAR(500)  NOT NULL,
  city         VARCHAR(60)   NULL,
  pincode      VARCHAR(6)    NULL,
  state_code   CHAR(2)       NOT NULL,
  gstin        VARCHAR(15)   NULL,
  phone        VARCHAR(30)   NULL,
  is_default   TINYINT(1)    NOT NULL DEFAULT 0,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_caddr_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_caddr_contact FOREIGN KEY (contact_id) REFERENCES contacts(id),
  KEY idx_caddr_contact (org_id, contact_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
