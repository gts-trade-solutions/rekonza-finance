-- Zoho Books' retainer invoice (recorded from Zoho's demo on 2026-11-23):
-- Reference#, Project Name, a DESCRIPTION | AMOUNT table of several lines,
-- Customer Notes and Terms & Conditions. `description` and `amount` stay what
-- they were (the lines joined, and their sum), so every report and the
-- ledger read the retainer exactly as before.
ALTER TABLE retainer_invoices
  ADD COLUMN reference   VARCHAR(100) NULL AFTER number,
  ADD COLUMN project_id  BIGINT       NULL AFTER customer_id,
  ADD COLUMN notes       TEXT         NULL AFTER description,
  ADD COLUMN terms       TEXT         NULL AFTER notes,
  ADD COLUMN `lines`     JSON         NULL AFTER terms;
