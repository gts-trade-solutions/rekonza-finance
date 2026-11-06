-- A LUT is declared only with the dates it covers. Migration 109 marked every
-- organisation with an ARN on file as declared, dates or not; one without
-- dates cannot show that a LUT covered an export, so it is a "no" until the
-- dates are entered in Settings → Organisation, and its exports pay IGST.
UPDATE organizations
   SET lut_declared = 0, export_igst = 'paid'
 WHERE lut_declared = 1 AND (lut_arn IS NULL OR lut_arn = '' OR lut_valid_from IS NULL OR lut_valid_to IS NULL);
