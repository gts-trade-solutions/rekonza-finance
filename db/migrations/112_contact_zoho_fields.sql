-- Zoho Books' customer and vendor, field for field.
--
--   contact_type          Zoho's "Customer Type": a business or an individual.
--   salutation, first_name, last_name
--                         the primary contact's name (the display name is
--                         what documents print; this is the person).
--   mobile                beside the work phone (`phone`).
--   language              the language documents and emails go out in.
--   website, twitter, facebook, skype, department, designation
--                         Zoho's "Add more details".
--   tax_preference, tax_exemption_reason
--                         "Taxable" or "Tax Exempt", and why.
--   billing_* and shipping_*
--                         each address as Zoho keeps it: attention, two street
--                         lines (`*_address` is the first), city, state, PIN,
--                         country, phone and fax.
--
-- A contact person gets a first and last name and a mobile too; `name` stays
-- the whole name, as everything printed reads it.
ALTER TABLE contacts
  ADD COLUMN contact_type ENUM('business', 'individual') NOT NULL DEFAULT 'business' AFTER kind,
  ADD COLUMN salutation VARCHAR(20) NULL AFTER legal_name,
  ADD COLUMN first_name VARCHAR(100) NULL AFTER salutation,
  ADD COLUMN last_name VARCHAR(100) NULL AFTER first_name,
  ADD COLUMN mobile VARCHAR(30) NULL AFTER phone,
  ADD COLUMN language VARCHAR(40) NOT NULL DEFAULT 'English' AFTER mobile,
  ADD COLUMN website VARCHAR(255) NULL AFTER language,
  ADD COLUMN twitter VARCHAR(100) NULL AFTER website,
  ADD COLUMN facebook VARCHAR(100) NULL AFTER twitter,
  ADD COLUMN skype VARCHAR(100) NULL AFTER facebook,
  ADD COLUMN department VARCHAR(100) NULL AFTER skype,
  ADD COLUMN designation VARCHAR(100) NULL AFTER department,
  ADD COLUMN tax_preference ENUM('taxable', 'exempt') NOT NULL DEFAULT 'taxable' AFTER gst_treatment,
  ADD COLUMN tax_exemption_reason VARCHAR(200) NULL AFTER tax_preference,
  ADD COLUMN billing_attention VARCHAR(150) NULL AFTER billing_address,
  ADD COLUMN billing_street2 VARCHAR(255) NULL AFTER billing_attention,
  ADD COLUMN billing_state VARCHAR(80) NULL AFTER billing_city,
  ADD COLUMN billing_country VARCHAR(80) NULL AFTER billing_pincode,
  ADD COLUMN billing_phone VARCHAR(30) NULL AFTER billing_country,
  ADD COLUMN billing_fax VARCHAR(30) NULL AFTER billing_phone,
  ADD COLUMN shipping_attention VARCHAR(150) NULL AFTER shipping_address,
  ADD COLUMN shipping_street2 VARCHAR(255) NULL AFTER shipping_attention,
  ADD COLUMN shipping_state VARCHAR(80) NULL AFTER shipping_city,
  ADD COLUMN shipping_country VARCHAR(80) NULL AFTER shipping_pincode,
  ADD COLUMN shipping_phone VARCHAR(30) NULL AFTER shipping_country,
  ADD COLUMN shipping_fax VARCHAR(30) NULL AFTER shipping_phone;

ALTER TABLE contact_persons
  ADD COLUMN first_name VARCHAR(100) NULL AFTER salutation,
  ADD COLUMN last_name VARCHAR(100) NULL AFTER first_name,
  ADD COLUMN mobile VARCHAR(30) NULL AFTER phone;

-- A person already on file: their name split at its first space.
UPDATE contact_persons
   SET first_name = TRIM(SUBSTRING_INDEX(name, ' ', 1)),
       last_name = NULLIF(TRIM(SUBSTRING(name, LENGTH(SUBSTRING_INDEX(name, ' ', 1)) + 1)), '')
 WHERE first_name IS NULL;
