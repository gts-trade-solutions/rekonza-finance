-- Making things, and having them worked on.
--
-- A bill of materials says what goes into a batch of a finished item. A
-- production consumes the components and makes the item; its cost is fixed
-- when it is recorded — the components at their cost that day, plus any
-- overhead absorbed (AS 2) — and the finished goods enter stock at it.
--
-- Goods sent to a job worker on a job-work challan stay the business's own
-- stock. They come back on a job-work receipt, with any waste; what is not
-- back within a year (three for capital goods) is treated as supplied on the
-- day it went (CGST Act s.143). ITC-04 reports both directions.

CREATE TABLE IF NOT EXISTS boms (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id       BIGINT        NOT NULL,
  item_id      BIGINT        NOT NULL,
  name         VARCHAR(100)  NOT NULL,
  output_qty   DECIMAL(14,3) NOT NULL DEFAULT 1,
  is_active    TINYINT(1)    NOT NULL DEFAULT 1,
  notes        VARCHAR(300)  NULL,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_bom_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_bom_item FOREIGN KEY (item_id) REFERENCES items(id),
  UNIQUE KEY uq_bom_name (org_id, item_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bom_lines (
  id        BIGINT AUTO_INCREMENT PRIMARY KEY,
  bom_id    BIGINT        NOT NULL,
  item_id   BIGINT        NOT NULL,
  qty       DECIMAL(14,4) NOT NULL,
  CONSTRAINT fk_bomline_bom FOREIGN KEY (bom_id) REFERENCES boms(id) ON DELETE CASCADE,
  CONSTRAINT fk_bomline_item FOREIGN KEY (item_id) REFERENCES items(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS productions (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  number              VARCHAR(20)   NOT NULL,
  bom_id              BIGINT        NULL,
  item_id             BIGINT        NOT NULL,
  branch_id           BIGINT        NOT NULL,
  qty                 DECIMAL(14,3) NOT NULL,
  produced_on         DATE          NOT NULL,
  components_cost     DECIMAL(19,4) NOT NULL,
  overhead            DECIMAL(19,4) NOT NULL DEFAULT 0,
  cost                DECIMAL(19,4) NOT NULL,
  status              ENUM('done','void') NOT NULL DEFAULT 'done',
  notes               VARCHAR(300)  NULL,
  created_by_user_id  BIGINT        NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_prod_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_prod_item FOREIGN KEY (item_id) REFERENCES items(id),
  CONSTRAINT fk_prod_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  UNIQUE KEY uq_prod_number (org_id, number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS production_lines (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  production_id  BIGINT        NOT NULL,
  item_id        BIGINT        NOT NULL,
  qty            DECIMAL(14,4) NOT NULL,
  cost           DECIMAL(19,4) NOT NULL,
  CONSTRAINT fk_prodline_prod FOREIGN KEY (production_id) REFERENCES productions(id) ON DELETE CASCADE,
  CONSTRAINT fk_prodline_item FOREIGN KEY (item_id) REFERENCES items(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS job_work_receipts (
  id                      BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id                  BIGINT        NOT NULL,
  challan_id              BIGINT        NOT NULL,
  received_date           DATE          NOT NULL,
  job_worker_challan_no   VARCHAR(30)   NULL,
  job_worker_challan_date DATE          NULL,
  nature_of_job           VARCHAR(100)  NULL,
  notes                   VARCHAR(300)  NULL,
  created_by_user_id      BIGINT        NULL,
  created_at              TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_jwr_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_jwr_challan FOREIGN KEY (challan_id) REFERENCES delivery_challans(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS job_work_receipt_lines (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  receipt_id       BIGINT        NOT NULL,
  challan_line_id  BIGINT        NOT NULL,
  qty_received     DECIMAL(14,3) NOT NULL DEFAULT 0,
  qty_waste        DECIMAL(14,3) NOT NULL DEFAULT 0,
  CONSTRAINT fk_jwrl_receipt FOREIGN KEY (receipt_id) REFERENCES job_work_receipts(id) ON DELETE CASCADE,
  CONSTRAINT fk_jwrl_line FOREIGN KEY (challan_line_id) REFERENCES challan_lines(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
