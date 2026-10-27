-- The batch goods arrived in, on the receipt note: they are in stock from the
-- day they arrive, so their batch is too. The bill made from the note carries
-- the same batch on, and from then the bill holds them.

ALTER TABLE goods_receipt_lines
  ADD COLUMN batch_id BIGINT NULL,
  ADD CONSTRAINT fk_grl_batch FOREIGN KEY (batch_id) REFERENCES batches(id);
