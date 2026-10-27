-- 003_masters.sql
-- Contacts, items, and the organisation's approved HSN/SAC list.

CREATE TABLE IF NOT EXISTS contacts (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  kind              ENUM('customer','vendor','both') NOT NULL DEFAULT 'customer',
  display_name      VARCHAR(200)  NOT NULL,
  legal_name        VARCHAR(200)  NULL,
  -- GST treatment decides whether tax is charged, who pays it, and which
  -- GSTR-1 table the supply lands in. It is not a label; it drives the maths.
  gst_treatment     ENUM('registered','unregistered','composition','overseas','sez','sez_developer','deemed_export','uin') NOT NULL DEFAULT 'unregistered',
  gstin             CHAR(15)      NULL,
  pan               CHAR(10)      NULL,
  state_code        CHAR(2)       NOT NULL,
  -- Section 43B(h): an MSME supplier unpaid past 45 days makes the expense
  -- disallowable, so the flag has to live on the vendor, not in a spreadsheet.
  is_msme           TINYINT(1)    NOT NULL DEFAULT 0,
  msme_udyam_no     VARCHAR(30)   NULL,
  email             VARCHAR(255)  NULL,
  phone             VARCHAR(30)   NULL,
  billing_address   VARCHAR(500)  NULL,
  shipping_address  VARCHAR(500)  NULL,
  payment_terms     VARCHAR(20)   NULL,
  credit_limit      DECIMAL(19,4) NULL,
  opening_balance   DECIMAL(19,4) NOT NULL DEFAULT 0,
  tds_applicable    TINYINT(1)    NOT NULL DEFAULT 0,
  tds_section       VARCHAR(10)   NULL,
  notes             VARCHAR(1000) NULL,
  is_archived       TINYINT(1)    NOT NULL DEFAULT 0,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_contacts_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  KEY idx_contacts_org_kind (org_id, kind, is_archived),
  KEY idx_contacts_name (org_id, display_name),
  KEY idx_contacts_gstin (org_id, gstin)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The approved code list. Invoice lines may pick from here and nowhere else,
-- because GSTR-1 Table 12 is validated against the official master and a code
-- that does not exist bounces the whole return rather than one line.
CREATE TABLE IF NOT EXISTS hsn_codes (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id        BIGINT        NOT NULL,
  code          VARCHAR(8)    NOT NULL,
  kind          ENUM('hsn','sac') NOT NULL,
  description   VARCHAR(300)  NOT NULL,
  gst_rate_pct  DECIMAL(6,3)  NOT NULL DEFAULT 18,
  uqc           VARCHAR(10)   NULL,
  is_active     TINYINT(1)    NOT NULL DEFAULT 1,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_hsn_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_hsn_org_code (org_id, code),
  KEY idx_hsn_org_active (org_id, is_active, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS items (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  kind                ENUM('goods','service') NOT NULL DEFAULT 'goods',
  name                VARCHAR(200)  NOT NULL,
  sku                 VARCHAR(60)   NULL,
  hsn_sac             VARCHAR(8)    NULL,
  uqc                 VARCHAR(10)   NOT NULL DEFAULT 'NOS',
  sale_price          DECIMAL(19,4) NOT NULL DEFAULT 0,
  purchase_price      DECIMAL(19,4) NOT NULL DEFAULT 0,
  gst_rate_pct        DECIMAL(6,3)  NOT NULL DEFAULT 18,
  tax_pref            ENUM('taxable','exempt','nil','non_gst') NOT NULL DEFAULT 'taxable',
  sale_account_id     BIGINT        NULL,
  purchase_account_id BIGINT        NULL,
  description         VARCHAR(1000) NULL,
  -- Inventory is deferred by scope decision: items exist, stock does not.
  -- The columns are here so turning it on later is a feature, not a migration.
  track_inventory     TINYINT(1)    NOT NULL DEFAULT 0,
  opening_stock_qty   DECIMAL(19,6) NULL,
  reorder_level       DECIMAL(19,6) NULL,
  is_archived         TINYINT(1)    NOT NULL DEFAULT 0,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_items_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_items_sale_acct FOREIGN KEY (sale_account_id) REFERENCES accounts(id),
  CONSTRAINT fk_items_purch_acct FOREIGN KEY (purchase_account_id) REFERENCES accounts(id),
  UNIQUE KEY uq_items_org_sku (org_id, sku),
  KEY idx_items_org (org_id, is_archived, kind),
  KEY idx_items_name (org_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
