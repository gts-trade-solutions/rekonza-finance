-- Where the business sells and what it supplies, and its Letter of Undertaking
-- as a plain yes or no.
--
--   trade_scope   within India only, abroad as well, or abroad only
--   supplies      goods, services, or both (goods carry HSN codes, services SAC)
--   lut_declared  a LUT (Form GST RFD-11) is filed for the year: exports may
--                 then go without IGST. Without one, IGST is paid on them.
--   export_igst   what an export takes when nobody chooses: IGST nil under the
--                 LUT, or IGST paid and claimed back as a refund
--
-- An invoice keeps the ARN it was raised under, so a later year's LUT never
-- reprints on it.
ALTER TABLE organizations
  ADD COLUMN trade_scope ENUM('domestic', 'both', 'international') NOT NULL DEFAULT 'domestic' AFTER business_nature,
  ADD COLUMN supplies ENUM('goods', 'services', 'both') NOT NULL DEFAULT 'both' AFTER trade_scope,
  ADD COLUMN lut_declared TINYINT(1) NOT NULL DEFAULT 0 AFTER lut_arn,
  ADD COLUMN export_igst ENUM('nil_lut', 'paid') NOT NULL DEFAULT 'nil_lut' AFTER lut_valid_to;

ALTER TABLE invoices
  ADD COLUMN export_lut_arn VARCHAR(20) NULL AFTER export_currency;

-- A LUT already on file was declared.
UPDATE organizations SET lut_declared = 1 WHERE lut_arn IS NOT NULL AND lut_arn <> '';

-- A business with overseas or SEZ customers, or exports already raised, sells abroad too.
UPDATE organizations o SET trade_scope = 'both'
 WHERE EXISTS (SELECT 1 FROM contacts c WHERE c.org_id = o.id AND c.gst_treatment IN ('overseas', 'sez'))
    OR EXISTS (SELECT 1 FROM invoices i WHERE i.org_id = o.id AND i.supply_type IN ('export_lut', 'export_with_tax', 'sez'));

-- What it supplies, from its items: only goods, only services, or both.
UPDATE organizations o SET supplies = 'goods'
 WHERE EXISTS (SELECT 1 FROM items i WHERE i.org_id = o.id AND i.kind = 'goods')
   AND NOT EXISTS (SELECT 1 FROM items i WHERE i.org_id = o.id AND i.kind = 'service');
UPDATE organizations o SET supplies = 'services'
 WHERE EXISTS (SELECT 1 FROM items i WHERE i.org_id = o.id AND i.kind = 'service')
   AND NOT EXISTS (SELECT 1 FROM items i WHERE i.org_id = o.id AND i.kind = 'goods');

-- Exports already raised under a LUT keep the one on file.
UPDATE invoices i JOIN organizations o ON o.id = i.org_id
   SET i.export_lut_arn = o.lut_arn
 WHERE i.supply_type = 'export_lut' AND o.lut_arn IS NOT NULL
   AND (o.lut_valid_from IS NULL OR i.invoice_date >= o.lut_valid_from)
   AND (o.lut_valid_to IS NULL OR i.invoice_date <= o.lut_valid_to);
