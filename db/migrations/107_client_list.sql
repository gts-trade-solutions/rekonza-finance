-- The client's list, items 7 to 21.
--
-- Customers: the country of an international one (ISO code; its state is 96,
-- Foreign Country), and whether it buys goods, services or both, which narrows
-- the items offered on its documents.
ALTER TABLE contacts
  ADD COLUMN country CHAR(2) NULL,
  ADD COLUMN supplies ENUM('goods', 'service', 'both') NOT NULL DEFAULT 'both';

-- Items: made or bought in India, or imported. Imported goods pay IGST at
-- customs on the Bill of Entry; an imported service pays it by reverse charge.
ALTER TABLE items
  ADD COLUMN origin ENUM('local', 'imported') NOT NULL DEFAULT 'local';

-- The company's registration, as Settings shows it: the kind of company, what
-- it does (several, comma-separated), its CIN and the dates it was
-- incorporated and registered for GST.
ALTER TABLE organizations
  ADD COLUMN constitution VARCHAR(60) NULL,
  ADD COLUMN business_nature VARCHAR(200) NULL,
  ADD COLUMN cin VARCHAR(21) NULL,
  ADD COLUMN incorporated_on DATE NULL,
  ADD COLUMN gst_registered_on DATE NULL;

-- A sales order's stage between the order and the invoice: a proforma invoice
-- sent, work in process, ready for delivery (which raises the invoice).
ALTER TABLE sales_orders
  ADD COLUMN stage ENUM('order', 'proforma', 'in_process', 'ready') NOT NULL DEFAULT 'order',
  ADD COLUMN proforma_number VARCHAR(40) NULL,
  ADD COLUMN proforma_date DATE NULL,
  ADD COLUMN stage_changed_at DATETIME NULL;
