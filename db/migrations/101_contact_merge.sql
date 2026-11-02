-- Merging two customers or two vendors, as Zoho Books does: every document,
-- payment and ledger line of one moves to the other, and the one merged away
-- is archived with a pointer to where it went (lib/server/services/contact-merge.ts).
ALTER TABLE contacts
  ADD COLUMN merged_into_id BIGINT NULL,
  ADD COLUMN merged_at TIMESTAMP NULL;
