-- 014_inventory.sql
-- Warehouses and stock adjustments.
--
-- Stock on hand is not stored. It is derived: opening quantity, plus what the
-- bills brought in, less what the invoices sent out, plus or minus whatever has
-- been adjusted. The documents are the record, so a stored running quantity
-- could only ever be a second copy to fall out of step with them — and a stock
-- figure that disagrees with the purchase and sales history is worse than no
-- figure at all.
--
-- What cannot be derived is an adjustment: damage, theft, a stocktake
-- correction. Those have no document behind them, so they get a table.

CREATE TABLE IF NOT EXISTS warehouses (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id       BIGINT        NOT NULL,
  branch_id    BIGINT        NULL,
  name         VARCHAR(150)  NOT NULL,
  code         VARCHAR(20)   NULL,
  address      VARCHAR(500)  NULL,
  is_primary   TINYINT(1)    NOT NULL DEFAULT 0,
  is_active    TINYINT(1)    NOT NULL DEFAULT 1,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_wh_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_wh_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  UNIQUE KEY uq_wh_name (org_id, name),
  KEY idx_wh_org (org_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock_adjustments (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id        BIGINT        NOT NULL,
  warehouse_id  BIGINT        NULL,
  item_id       BIGINT        NOT NULL,
  adjust_date   DATE          NOT NULL,
  -- Signed. Negative writes stock off, positive corrects it upward.
  qty_delta     DECIMAL(19,6) NOT NULL,
  reason        ENUM('damage','theft','stocktake','expiry','sample','opening','other')
                              NOT NULL DEFAULT 'stocktake',
  notes         VARCHAR(500)  NULL,
  -- An adjustment that changes the value of stock should post to the ledger.
  -- Left nullable because a quantity-only correction on an item carried at nil
  -- value moves no money and should not manufacture an entry.
  journal_entry_id BIGINT     NULL,
  created_by_user_id BIGINT   NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_adj_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_adj_item FOREIGN KEY (item_id) REFERENCES items(id),
  CONSTRAINT fk_adj_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT ck_adj_nonzero CHECK (qty_delta <> 0),
  KEY idx_adj_item (org_id, item_id, adjust_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
