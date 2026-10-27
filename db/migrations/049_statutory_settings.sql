-- Statutory settings a business has to be able to change as its position does.
--
--   * GST registration type, with the date each change took effect. A business
--     that leaves composition on 1 April issued bills of supply before it and
--     tax invoices after; each document keeps the type in force on its date.
--   * E-invoicing: from when it applies. Once turnover passes ₹5 crore in any
--     year since 2017-18 it applies from the next 1 April, and never lapses.
--   * The person responsible for deducting tax, as the TDS return reports them.
--   * A branch's own intra-state e-way bill threshold, where its state has
--     notified one above ₹50,000 and the built-in table is not right.

CREATE TABLE IF NOT EXISTS gst_registration_changes (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id             BIGINT       NOT NULL,
  effective_from     DATE         NOT NULL,
  from_type          ENUM('regular','composition','unregistered') NOT NULL,
  to_type            ENUM('regular','composition','unregistered') NOT NULL,
  reason             VARCHAR(300) NOT NULL,
  created_by_user_id BIGINT       NULL,
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_grc_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_grc_user FOREIGN KEY (created_by_user_id) REFERENCES users(id),
  KEY idx_grc_org (org_id, effective_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE organizations
  ADD COLUMN einvoice_from       DATE         NULL AFTER aato_above_5cr,
  ADD COLUMN deductor_type       VARCHAR(30)  NULL AFTER tan,
  ADD COLUMN tds_rp_name         VARCHAR(100) NULL AFTER deductor_type,
  ADD COLUMN tds_rp_designation  VARCHAR(60)  NULL AFTER tds_rp_name,
  ADD COLUMN tds_rp_pan          CHAR(10)     NULL AFTER tds_rp_designation,
  ADD COLUMN tds_rp_mobile       VARCHAR(15)  NULL AFTER tds_rp_pan,
  ADD COLUMN tds_rp_email        VARCHAR(150) NULL AFTER tds_rp_mobile;

ALTER TABLE branches
  ADD COLUMN eway_intra_threshold DECIMAL(19,4) NULL;
