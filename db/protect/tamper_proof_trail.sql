-- tamper_proof_trail.sql — applied by `npm run db:protect`, not by db:migrate.
-- The audit trail and the journal cannot be changed, by the application or by
-- anyone with a database login.
--
-- Kept out of the migration sequence because creating a trigger on a MySQL
-- server with binary logging on needs either the SUPER privilege or the server
-- setting log_bin_trust_function_creators = 1. That is a decision for whoever
-- runs the database, not something a migration should demand; see
-- scripts/db-protect.mjs. Safe to run again: every trigger is dropped first.
--
-- Rule 3(1) of the Companies (Accounts) Rules requires accounting software to
-- keep an edit log of every change that cannot be disabled, and the auditor
-- reports on whether it was tampered with (Rule 11(g)). Until now that was a
-- promise kept by the code alone: nothing in the application updates or deletes
-- these rows, but a direct UPDATE in a database console would have gone
-- through silently. These triggers make the database refuse it.
--
-- The one exception is the demo book. Resetting the sample company deletes its
-- rows (scripts/seed.ts --fresh), and a sample company has no statutory record
-- to protect. A real book is never a demo one.

DROP TRIGGER IF EXISTS trg_audit_log_no_update;
CREATE TRIGGER trg_audit_log_no_update BEFORE UPDATE ON audit_log
FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The audit trail cannot be changed.';

DROP TRIGGER IF EXISTS trg_audit_log_no_delete;
CREATE TRIGGER trg_audit_log_no_delete BEFORE DELETE ON audit_log
FOR EACH ROW
BEGIN
  IF COALESCE((SELECT is_demo FROM organizations WHERE id = OLD.org_id), 0) = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The audit trail cannot be deleted.';
  END IF;
END;

-- A posted entry is corrected by a reversing entry, never by an edit.
DROP TRIGGER IF EXISTS trg_journal_entries_no_update;
CREATE TRIGGER trg_journal_entries_no_update BEFORE UPDATE ON journal_entries
FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A posted journal entry cannot be changed. Reverse it instead.';

DROP TRIGGER IF EXISTS trg_journal_entries_no_delete;
CREATE TRIGGER trg_journal_entries_no_delete BEFORE DELETE ON journal_entries
FOR EACH ROW
BEGIN
  IF COALESCE((SELECT is_demo FROM organizations WHERE id = OLD.org_id), 0) = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A posted journal entry cannot be deleted. Reverse it instead.';
  END IF;
END;

DROP TRIGGER IF EXISTS trg_journal_lines_no_update;
CREATE TRIGGER trg_journal_lines_no_update BEFORE UPDATE ON journal_lines
FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A posted journal line cannot be changed. Reverse the entry instead.';

DROP TRIGGER IF EXISTS trg_journal_lines_no_delete;
CREATE TRIGGER trg_journal_lines_no_delete BEFORE DELETE ON journal_lines
FOR EACH ROW
BEGIN
  IF COALESCE((SELECT is_demo FROM organizations WHERE id = OLD.org_id), 0) = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A posted journal line cannot be deleted. Reverse the entry instead.';
  END IF;
END;
