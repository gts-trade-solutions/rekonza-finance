-- 010_sequences.sql
-- A single-row counter per named sequence, per organisation.
--
-- Journal entry numbers were being allocated with
--   SELECT COALESCE(MAX(entry_no), 0) + 1 FROM journal_entries
--    WHERE org_id = ? FOR UPDATE
--
-- which is correct in isolation and wrong under load. FOR UPDATE on an
-- aggregate takes next-key locks across the range InnoDB scans, including the
-- supremum, so two transactions posting at the same time can each hold part of
-- what the other needs. That is a deadlock, and it showed up the moment two
-- test files ran concurrently.
--
-- One row, locked with SELECT ... FOR UPDATE, takes exactly one lock and holds
-- it for microseconds. Postings for one organisation still serialise — they
-- must, or entry numbers would collide — but they no longer block anyone else,
-- and there is no range for a second transaction to overlap.

CREATE TABLE IF NOT EXISTS sequences (
  org_id      BIGINT      NOT NULL,
  name        VARCHAR(40) NOT NULL,
  next_value  BIGINT      NOT NULL DEFAULT 1,
  updated_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id, name),
  CONSTRAINT fk_sequences_org FOREIGN KEY (org_id) REFERENCES organizations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed the entry counter for any organisation that already has entries, so an
-- existing book carries on from where it left off rather than restarting at 1.
INSERT INTO sequences (org_id, name, next_value)
SELECT org_id, 'journal_entry', MAX(entry_no) + 1
  FROM journal_entries
 GROUP BY org_id
ON DUPLICATE KEY UPDATE next_value = GREATEST(sequences.next_value, VALUES(next_value));
