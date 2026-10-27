-- 028_schedule_iii.sql
-- Where an account appears in the Schedule III balance sheet and profit and
-- loss.
--
-- Left empty, the line follows from the account's type, subtype and code
-- (lib/server/reports/schedule-iii.ts). A CA who wants an account elsewhere —
-- a loan from a director under long-term borrowings, say — sets it here, and
-- the statements follow.

ALTER TABLE accounts
  ADD COLUMN schedule_iii_line VARCHAR(40) NULL AFTER subtype;
