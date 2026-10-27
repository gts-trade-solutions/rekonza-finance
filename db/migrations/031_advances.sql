-- Advances: money received before the invoice, or paid before the bill, and
-- set against it later.
--
-- The money was always kept (payments.unapplied_amount), but nothing could
-- apply it afterwards. An allocation now records when it was made, because
-- the GST on an advance is adjusted in the month the advance is applied.
--
-- GST on an advance for services is due when the money arrives (section 13 of
-- the CGST Act; advances for goods are exempt from this by notification
-- 66/2017-CT). The tax is worked out of the amount received, which includes
-- it, posted at once, and taken back as the advance is applied to invoices
-- that charge the tax themselves. GSTR-1 reports the first in table 11A and
-- the second in table 11B.

ALTER TABLE payment_allocations
  ADD COLUMN applied_on          DATE      NULL AFTER amount,
  ADD COLUMN created_by_user_id  BIGINT    NULL AFTER applied_on,
  ADD COLUMN created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER created_by_user_id;

-- Allocations made with the payment are applied on its own date.
UPDATE payment_allocations pa JOIN payments p ON p.id = pa.payment_id
   SET pa.applied_on = p.payment_date
 WHERE pa.applied_on IS NULL;

ALTER TABLE payments
  ADD COLUMN advance_gst          TINYINT(1)    NOT NULL DEFAULT 0 AFTER unapplied_amount,
  ADD COLUMN advance_rate_pct     DECIMAL(5,2)  NULL AFTER advance_gst,
  ADD COLUMN advance_pos          CHAR(2)       NULL AFTER advance_rate_pct,
  -- What the advance was worth when it arrived, tax included, and the tax in it.
  ADD COLUMN advance_amount       DECIMAL(19,4) NOT NULL DEFAULT 0 AFTER advance_pos,
  ADD COLUMN advance_cgst         DECIMAL(19,4) NOT NULL DEFAULT 0 AFTER advance_amount,
  ADD COLUMN advance_sgst         DECIMAL(19,4) NOT NULL DEFAULT 0 AFTER advance_cgst,
  ADD COLUMN advance_igst         DECIMAL(19,4) NOT NULL DEFAULT 0 AFTER advance_sgst;

-- Each time part of a taxed advance is set against an invoice, the tax on that
-- part is taken back, with its own entry.
CREATE TABLE IF NOT EXISTS advance_tax_adjustments (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  payment_id        BIGINT        NOT NULL,
  allocation_id     BIGINT        NULL,
  invoice_id        BIGINT        NOT NULL,
  adjusted_on       DATE          NOT NULL,
  -- The part of the advance applied, tax included.
  amount            DECIMAL(19,4) NOT NULL,
  cgst              DECIMAL(19,4) NOT NULL DEFAULT 0,
  sgst              DECIMAL(19,4) NOT NULL DEFAULT 0,
  igst              DECIMAL(19,4) NOT NULL DEFAULT 0,
  journal_entry_id  BIGINT        NULL,
  -- Set when the application is undone; the reversing entry is recorded too.
  reversed_at       TIMESTAMP     NULL,
  reversal_entry_id BIGINT        NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ata_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_ata_payment FOREIGN KEY (payment_id) REFERENCES payments(id),
  CONSTRAINT fk_ata_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id),
  KEY idx_ata_month (org_id, adjusted_on),
  KEY idx_ata_payment (payment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Where the tax on an advance waits until the invoice is raised.
INSERT INTO accounts (org_id, code, name, type, subtype, description, is_system, is_active)
SELECT o.id, '1350', 'GST paid on advances', 'asset', 'tax',
       'GST paid when an advance for services arrived; cleared as the advance is applied to invoices', 1, 1
  FROM organizations o
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id AND a.code = '1350');
