-- Zoho Books' recurring invoice profile (recorded from Zoho's demo on
-- 2026-11-23): "Repeat Every" Week, 2 Weeks, Month, 2/3/6 Months, Year,
-- 2/3 Years or Custom (every N days, weeks, months or years) — a unit and a
-- count; Order Number, Salesperson, Customer Notes, Terms & Conditions, and
-- the "Create Invoices as Drafts" preference. A profile saved before this
-- repeats every one of its unit, as it always did.
ALTER TABLE recurring_invoices
  MODIFY COLUMN frequency ENUM('daily','weekly','monthly','quarterly','yearly') NOT NULL DEFAULT 'monthly',
  ADD COLUMN repeat_every     SMALLINT     NOT NULL DEFAULT 1 AFTER frequency,
  ADD COLUMN order_number     VARCHAR(100) NULL AFTER profile_name,
  ADD COLUMN salesperson_id   BIGINT       NULL AFTER customer_id,
  ADD COLUMN notes            TEXT         NULL AFTER template,
  ADD COLUMN terms            TEXT         NULL AFTER notes,
  ADD COLUMN create_as_draft  TINYINT(1)   NOT NULL DEFAULT 0 AFTER auto_send;
