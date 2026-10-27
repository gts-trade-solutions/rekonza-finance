-- Batches and expiry.
--
-- An item can be tracked by batch: each purchase names the batch, with its
-- manufacturing and expiry dates, and each sale says which batch went —
-- earliest expiry first unless someone picks otherwise. Stock by batch is
-- worked out from the lines, as stock by item is.

ALTER TABLE items
  ADD COLUMN track_batches TINYINT(1) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS batches (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id       BIGINT       NOT NULL,
  item_id      BIGINT       NOT NULL,
  batch_no     VARCHAR(40)  NOT NULL,
  mfg_date     DATE         NULL,
  expiry_date  DATE         NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_batch_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_batch_item FOREIGN KEY (item_id) REFERENCES items(id),
  UNIQUE KEY uq_batch (org_id, item_id, batch_no),
  KEY idx_batch_expiry (org_id, expiry_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE bill_lines ADD COLUMN batch_id BIGINT NULL, ADD CONSTRAINT fk_bl_batch FOREIGN KEY (batch_id) REFERENCES batches(id);
ALTER TABLE invoice_lines ADD COLUMN batch_id BIGINT NULL, ADD CONSTRAINT fk_il_batch FOREIGN KEY (batch_id) REFERENCES batches(id);
ALTER TABLE credit_note_lines ADD COLUMN batch_id BIGINT NULL, ADD CONSTRAINT fk_cnl_batch FOREIGN KEY (batch_id) REFERENCES batches(id);
ALTER TABLE stock_adjustments ADD COLUMN batch_id BIGINT NULL, ADD CONSTRAINT fk_sa_batch FOREIGN KEY (batch_id) REFERENCES batches(id);
