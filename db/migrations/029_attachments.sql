-- Attachments: bill scans, signed delivery challans, contracts, the logo.
--
-- The files table has existed since 007 as an index of stored objects; nothing
-- wrote to it. An attachment is evidence for an entry in the books, so taking
-- one off does not erase it: it is marked removed, keeps its bytes, and the
-- audit log says who did it.

ALTER TABLE files
  ADD COLUMN deleted_at          TIMESTAMP NULL AFTER created_at,
  ADD COLUMN deleted_by_user_id  BIGINT    NULL AFTER deleted_at;
