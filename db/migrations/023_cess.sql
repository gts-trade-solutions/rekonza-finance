-- 023_cess.sql
-- Compensation cess, end to end.
--
-- The lines already had a cess amount, but nothing ever put a number in it and
-- nothing posted it. Cess is decided by what the goods are, so its rate lives
-- on the HSN code, and each line keeps the rate it was raised at — the
-- e-invoice reports the rate as well as the amount.

ALTER TABLE hsn_codes
  ADD COLUMN cess_rate_pct DECIMAL(6,3) NOT NULL DEFAULT 0 AFTER gst_rate_pct;

ALTER TABLE invoice_lines
  ADD COLUMN cess_rate_pct DECIMAL(6,3) NOT NULL DEFAULT 0 AFTER gst_rate_pct;

ALTER TABLE credit_note_lines
  ADD COLUMN cess_rate_pct DECIMAL(6,3) NOT NULL DEFAULT 0 AFTER gst_rate_pct;

ALTER TABLE bill_lines
  ADD COLUMN cess_rate_pct DECIMAL(6,3) NOT NULL DEFAULT 0 AFTER gst_rate_pct;

-- The two cess ledgers, for every book that already exists. New books get them
-- from the standard chart at sign-up. Input cess is kept apart from GST input
-- credit because it can only be set off against output cess.
INSERT INTO accounts (org_id, code, name, type, subtype, description, is_system, is_active)
SELECT o.id, '1340', 'Input Cess (ITC)', 'asset', 'tax',
       'Compensation cess paid on purchases; it can only be set off against output cess', 1, 1
  FROM organizations o
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id AND a.code = '1340');

INSERT INTO accounts (org_id, code, name, type, subtype, description, is_system, is_active)
SELECT o.id, '2250', 'Output Cess Payable', 'liability', 'tax', NULL, 1, 1
  FROM organizations o
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id AND a.code = '2250');
