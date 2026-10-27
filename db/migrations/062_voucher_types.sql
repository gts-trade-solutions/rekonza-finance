-- Voucher types: named kinds of a document, each with its own number series —
-- "Export invoice" numbered EXP/26-27/0001 beside the ordinary INV series, as
-- Tally's voucher types allow. GST permits several series in a year (Rule 46),
-- each unique; a distinct prefix keeps them apart.

CREATE TABLE IF NOT EXISTS voucher_types (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id      BIGINT       NOT NULL,
  doc_type    VARCHAR(10)  NOT NULL,
  code        VARCHAR(10)  NOT NULL,
  name        VARCHAR(60)  NOT NULL,
  prefix      VARCHAR(10)  NOT NULL,
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_vt_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_vt_code (org_id, doc_type, code),
  UNIQUE KEY uq_vt_prefix (org_id, prefix)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE invoices
  ADD COLUMN voucher_type_id BIGINT NULL,
  ADD CONSTRAINT fk_inv_vt FOREIGN KEY (voucher_type_id) REFERENCES voucher_types(id);
