-- 013_budget_uniqueness.sql
-- The unique key on budgets did not actually hold.
--
-- MySQL treats NULLs in a unique index as distinct from each other, so with
-- branch_id NULL meaning "all branches", every insert created a new row rather
-- than updating the existing one. Two budgets for the same account in the same
-- year would then both appear, silently doubling the target, with no way to
-- tell which the report used.
--
-- Zero stands for "all branches" instead. It is not a real branch id, the
-- column is not a foreign key, and a value that is never NULL is a value the
-- unique index can actually enforce.

DELETE b1 FROM budgets b1
  JOIN budgets b2
    ON b1.org_id = b2.org_id
   AND b1.fy_label = b2.fy_label
   AND b1.account_id = b2.account_id
   AND b1.id > b2.id;

UPDATE budgets SET branch_id = 0 WHERE branch_id IS NULL;

ALTER TABLE budgets
  MODIFY COLUMN branch_id BIGINT NOT NULL DEFAULT 0;
