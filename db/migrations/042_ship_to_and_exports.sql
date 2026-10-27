-- Where goods go, and what an export carries.
--
-- Place of supply for goods is where the movement ends (section 10(1)(a) of
-- the IGST Act) — the ship-to, not the bill-to — except when the goods go to
-- someone else on the buyer's instruction, when it is the buyer's own place of
-- business (10(1)(b)). So an invoice or challan can name its own ship-to, and
-- whether that is a third party.
--
-- An export's shipping bill is what the IGST refund is matched on and what
-- GSTR-1 reports; it often comes after the invoice, so it can be added later.
-- An export without payment of tax needs a Letter of Undertaking in force for
-- the year, quoted by its ARN.

ALTER TABLE invoices
  ADD COLUMN ship_to_name         VARCHAR(200) NULL AFTER place_of_supply,
  ADD COLUMN ship_to_gstin        CHAR(15)     NULL AFTER ship_to_name,
  ADD COLUMN ship_to_address      VARCHAR(500) NULL AFTER ship_to_gstin,
  ADD COLUMN ship_to_city         VARCHAR(60)  NULL AFTER ship_to_address,
  ADD COLUMN ship_to_pincode      CHAR(6)      NULL AFTER ship_to_city,
  ADD COLUMN ship_to_state_code   CHAR(2)      NULL AFTER ship_to_pincode,
  ADD COLUMN ship_to_third_party  TINYINT(1)   NOT NULL DEFAULT 0 AFTER ship_to_state_code,
  ADD COLUMN export_shipping_bill_no   VARCHAR(20) NULL AFTER ship_to_third_party,
  ADD COLUMN export_shipping_bill_date DATE        NULL AFTER export_shipping_bill_no,
  ADD COLUMN export_port_code          VARCHAR(6)  NULL AFTER export_shipping_bill_date,
  ADD COLUMN export_country            CHAR(2)     NULL AFTER export_port_code,
  ADD COLUMN export_currency           CHAR(3)     NULL AFTER export_country;

ALTER TABLE delivery_challans
  ADD COLUMN ship_to_name         VARCHAR(200) NULL AFTER place_of_supply,
  ADD COLUMN ship_to_address      VARCHAR(500) NULL AFTER ship_to_name,
  ADD COLUMN ship_to_city         VARCHAR(60)  NULL AFTER ship_to_address,
  ADD COLUMN ship_to_pincode      CHAR(6)      NULL AFTER ship_to_city,
  ADD COLUMN ship_to_state_code   CHAR(2)      NULL AFTER ship_to_pincode;

ALTER TABLE organizations
  ADD COLUMN lut_arn        VARCHAR(20) NULL AFTER tan,
  ADD COLUMN lut_valid_from DATE        NULL AFTER lut_arn,
  ADD COLUMN lut_valid_to   DATE        NULL AFTER lut_valid_from;
