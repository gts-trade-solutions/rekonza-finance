-- The rest of a stock item's master.
--
-- MRP: the price printed on the pack, which a sale may not exceed (Legal
-- Metrology). Standard cost: what the item is budgeted to cost, set against
-- what it actually cost. A second unit it is also counted in: bought by the
-- box, sold by the piece. A minimum level below the reorder level, where the
-- item is short rather than merely due for buying. And serial numbers, for
-- goods where each piece is told apart: warranty, service, theft.
--
-- Serial stock is worked out from the documents, as batch stock is: each line
-- that brings a numbered piece in or sends it out records a move, and a piece
-- is in stock while its live moves add up to more than nothing. A document
-- voided or cancelled stops counting without anything being rewritten.

ALTER TABLE items
  ADD COLUMN mrp            DECIMAL(19,4) NULL AFTER sale_price,
  ADD COLUMN standard_cost  DECIMAL(19,4) NULL AFTER purchase_price,
  ADD COLUMN alt_uqc        VARCHAR(10)   NULL AFTER uqc,
  -- How many of the main unit make one of the second: 1 BOX = 12 NOS.
  ADD COLUMN alt_factor     DECIMAL(19,6) NULL AFTER alt_uqc,
  ADD COLUMN min_level      DECIMAL(19,6) NULL AFTER reorder_level,
  ADD COLUMN track_serials  TINYINT(1)    NOT NULL DEFAULT 0 AFTER track_batches;

CREATE TABLE IF NOT EXISTS item_serials (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id      BIGINT       NOT NULL,
  item_id     BIGINT       NOT NULL,
  serial_no   VARCHAR(80)  NOT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_iser_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_iser_item FOREIGN KEY (item_id) REFERENCES items(id),
  UNIQUE KEY uq_item_serial (org_id, item_id, serial_no),
  KEY idx_iser_no (org_id, serial_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS serial_moves (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id      BIGINT       NOT NULL,
  serial_id   BIGINT       NOT NULL,
  doc_type    ENUM('bill','goods_receipt','invoice','credit_note','adjustment') NOT NULL,
  doc_id      BIGINT       NOT NULL,
  line_id     BIGINT       NULL,
  -- +1 the piece came in, -1 it went out.
  direction   TINYINT      NOT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_smove_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_smove_serial FOREIGN KEY (serial_id) REFERENCES item_serials(id),
  KEY idx_smove_serial (serial_id),
  KEY idx_smove_doc (org_id, doc_type, doc_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
