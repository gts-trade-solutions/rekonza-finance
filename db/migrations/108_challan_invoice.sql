-- A delivery challan sent with the invoice it went out on: the order marked
-- Ready for delivery raises the invoice and the challan together, and the
-- challan names that invoice (it was never invoiced from the challan itself).
ALTER TABLE delivery_challans
  ADD COLUMN invoice_id BIGINT NULL AFTER source_so_id;
