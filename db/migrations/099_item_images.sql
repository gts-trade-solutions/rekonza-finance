-- A picture of each item, as Zoho Books keeps one: shown on the item list and
-- in the item's form. The file itself is an ordinary attachment on the item
-- (lib/server/files/attachments.ts); this points at the one in use.
ALTER TABLE items
  ADD COLUMN image_file_id BIGINT NULL;
