-- 008_role_alignment.sql
-- The initial schema guessed 'purchase' as a role; the application has always
-- used 'staff'. Aligning the enum to the application rather than the reverse,
-- because the role names appear in the permission matrix, the UI and the audit
-- trail, and renaming them there would be a larger and more visible change.
--
-- Safe to run against live data: no user rows exist yet, and 'purchase' was
-- never written by anything.

ALTER TABLE users
  MODIFY COLUMN role ENUM('admin','accountant','sales','staff','viewer')
  NOT NULL DEFAULT 'viewer';

ALTER TABLE approval_rules
  MODIFY COLUMN approver_role ENUM('admin','accountant','sales','staff','viewer')
  NOT NULL DEFAULT 'admin';
