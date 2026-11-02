-- The Documents workspace, as Zoho Books has it: an inbox for files uploaded
-- before anyone knows which transaction they belong to, folders to keep them
-- in, and every file in the book listed in one place.
--
-- A file waiting in the inbox is attached to the organisation itself under
-- the type 'inbox' (lib/server/files/attachments.ts), so it is stored, served
-- and taken off exactly as any attachment is; attaching it to a bill later
-- moves it there. A folder is only a label on the file, so a file keeps its
-- folder when it moves from the inbox to a transaction.

ALTER TABLE files
  ADD COLUMN folder VARCHAR(100) NULL AFTER attached_to_id,
  ADD KEY idx_files_listing (org_id, deleted_at, created_at),
  ADD KEY idx_files_folder (org_id, folder);
