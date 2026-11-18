-- Zoho Books' item, field for field.
--
--   item_type             Zoho's "Sales Information" and "Purchase Information"
--                         ticks: an item sold, bought, or both. A sale-only item
--                         is not offered on bills and orders, a purchase-only
--                         one not on invoices and quotes.
--   is_digital_service    "It is a digital service" (OIDAR: online information
--                         and database access or retrieval), for a service.
--   upc, ean, isbn, mpn   the product codes Zoho keeps beside the SKU.
--   purchase_description  what a bill or order line says when the item is
--                         bought; the description is what a sale says.
--   preferred_vendor_id   who it is usually bought from; a new purchase order
--                         for the item starts with that vendor.
--   created_source        how the item came to be: typed in, or imported.
--
-- The item's sales account already existed but invoices ignored it, crediting
-- every line to Sales. From now on an invoice line credits its item's sales
-- account, as Zoho's does, and a credit note line debits the same one: the
-- account goes on the credit note line, as it already does on an invoice line.
ALTER TABLE items
  ADD COLUMN item_type ENUM('sales', 'purchases', 'sales_and_purchases') NOT NULL DEFAULT 'sales_and_purchases' AFTER kind,
  ADD COLUMN is_digital_service TINYINT(1) NOT NULL DEFAULT 0 AFTER item_type,
  ADD COLUMN upc VARCHAR(20) NULL AFTER sku,
  ADD COLUMN ean VARCHAR(20) NULL AFTER upc,
  ADD COLUMN isbn VARCHAR(20) NULL AFTER ean,
  ADD COLUMN mpn VARCHAR(40) NULL AFTER isbn,
  ADD COLUMN purchase_description VARCHAR(1000) NULL AFTER description,
  ADD COLUMN preferred_vendor_id BIGINT NULL AFTER purchase_account_id,
  ADD COLUMN created_source ENUM('user', 'import') NOT NULL DEFAULT 'user',
  ADD CONSTRAINT fk_items_pref_vendor FOREIGN KEY (preferred_vendor_id) REFERENCES contacts(id);

ALTER TABLE credit_note_lines
  ADD COLUMN account_id BIGINT NULL AFTER item_id,
  ADD CONSTRAINT fk_cnl_account FOREIGN KEY (account_id) REFERENCES accounts(id);
