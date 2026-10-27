-- Stock groups, valuation by item, stock by godown, payslips shared, and
-- entries made offline sent once.
--
-- Stock groups gather items for the stock reports (Spares, Lubricants), and
-- may sit inside one another. An item may be valued first in, first out or
-- at weighted average on its own, whatever the book's default.
--
-- A sale, a purchase, a receipt note, a credit note or a production names the
-- godown the goods leave or enter; one that names none uses its branch's main
-- godown, as everything did before. Stock by godown is worked out from these.
--
-- A payslip can be shared by link like an invoice: one employee's slip in one
-- month's payroll.
--
-- An entry made without a connection is kept on the device and sent when the
-- connection is back, with a key of its own. The key and the reply are kept
-- here, so an entry sent twice (the reply lost on the way back) is made once.

CREATE TABLE IF NOT EXISTS stock_groups (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id      BIGINT       NOT NULL,
  name        VARCHAR(100) NOT NULL,
  parent_id   BIGINT       NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sgrp_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_sgrp_parent FOREIGN KEY (parent_id) REFERENCES stock_groups(id),
  UNIQUE KEY uq_sgrp_name (org_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE items
  ADD COLUMN stock_group_id BIGINT NULL,
  -- Null follows the book's own method (Settings → Policies).
  ADD COLUMN valuation_method ENUM('average','fifo') NULL,
  ADD CONSTRAINT fk_items_sgrp FOREIGN KEY (stock_group_id) REFERENCES stock_groups(id);

ALTER TABLE invoices ADD COLUMN warehouse_id BIGINT NULL, ADD CONSTRAINT fk_inv_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses(id);
ALTER TABLE bills ADD COLUMN warehouse_id BIGINT NULL, ADD CONSTRAINT fk_bill_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses(id);
ALTER TABLE goods_receipts ADD COLUMN warehouse_id BIGINT NULL, ADD CONSTRAINT fk_grn_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses(id);
ALTER TABLE credit_notes ADD COLUMN warehouse_id BIGINT NULL, ADD CONSTRAINT fk_cn_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses(id);
ALTER TABLE productions ADD COLUMN warehouse_id BIGINT NULL, ADD CONSTRAINT fk_prod_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses(id);

ALTER TABLE share_links
  MODIFY COLUMN doc_type ENUM('invoice','payslip') NOT NULL,
  -- A payslip is a payroll month (doc_id) and an employee in it (sub_id).
  ADD COLUMN sub_id BIGINT NULL;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id       BIGINT        NOT NULL,
  user_id      BIGINT        NOT NULL,
  idem_key     VARCHAR(80)   NOT NULL,
  path         VARCHAR(200)  NOT NULL,
  status       SMALLINT      NULL,
  response     MEDIUMTEXT    NULL,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_idem (org_id, user_id, idem_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
