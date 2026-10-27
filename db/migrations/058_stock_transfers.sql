-- Moving stock between godowns and branches.
--
-- A transfer leaves its godown on the dispatch date and reaches the other on
-- the date it is received; in between it is stock in transit, still the
-- business's own but at neither place. Quantity only: average cost does not
-- change by moving goods. Between two GSTINs a transfer is a supply (CGST Act
-- Schedule I, para 2) and is billed on a tax invoice instead.

CREATE TABLE IF NOT EXISTS stock_transfers (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT       NOT NULL,
  number              VARCHAR(20)  NOT NULL,
  from_warehouse_id   BIGINT       NOT NULL,
  to_warehouse_id     BIGINT       NOT NULL,
  dispatch_date       DATE         NOT NULL,
  received_date       DATE         NULL,
  status              ENUM('in_transit','received','cancelled') NOT NULL DEFAULT 'in_transit',
  vehicle_no          VARCHAR(20)  NULL,
  eway_bill_no        VARCHAR(20)  NULL,
  notes               VARCHAR(300) NULL,
  created_by_user_id  BIGINT       NULL,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_st_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_st_from FOREIGN KEY (from_warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_st_to FOREIGN KEY (to_warehouse_id) REFERENCES warehouses(id),
  UNIQUE KEY uq_st_number (org_id, number),
  KEY idx_st_status (org_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock_transfer_lines (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  transfer_id  BIGINT        NOT NULL,
  item_id      BIGINT        NOT NULL,
  qty          DECIMAL(14,3) NOT NULL,
  CONSTRAINT fk_stl_transfer FOREIGN KEY (transfer_id) REFERENCES stock_transfers(id) ON DELETE CASCADE,
  CONSTRAINT fk_stl_item FOREIGN KEY (item_id) REFERENCES items(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
