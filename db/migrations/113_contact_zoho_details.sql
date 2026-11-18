-- Zoho Books' customer, the details the first pass missed.
--
--   gst_treatment          gains 'tax_deductor': Zoho's "Tax Deductor", a
--                          government department or agency registered to
--                          deduct TDS under GST. It holds a GSTIN and is
--                          invoiced as a registered business.
--   business_legal_name,   the registered names Zoho shows under the GSTIN
--   business_trade_name    ("Business Legal Name", "Business Trade Name"),
--                          filled from the GST portal. Company Name
--                          (legal_name) stays what documents print.
--   linked_contact_id      Zoho's "Link to Vendor" (and "Link to Customer"):
--                          a customer and a vendor that are the same business,
--                          kept as two contacts but shown together. Both
--                          sides point at each other.
ALTER TABLE contacts
  MODIFY gst_treatment ENUM('registered', 'registered_composition', 'unregistered', 'consumer', 'overseas', 'sez', 'sez_developer', 'deemed_export', 'uin', 'tax_deductor')
    COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'unregistered',
  ADD COLUMN business_legal_name VARCHAR(200) NULL AFTER legal_name,
  ADD COLUMN business_trade_name VARCHAR(200) NULL AFTER business_legal_name,
  ADD COLUMN linked_contact_id BIGINT NULL AFTER merged_into_id,
  ADD CONSTRAINT fk_contacts_linked FOREIGN KEY (linked_contact_id) REFERENCES contacts (id) ON DELETE SET NULL;
