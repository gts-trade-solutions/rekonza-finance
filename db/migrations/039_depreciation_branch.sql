-- Depreciation runs are per branch, as every journal entry is: a branch's
-- statement of profit and loss carries the depreciation of its own assets.
ALTER TABLE depreciation_runs
  ADD COLUMN branch_id BIGINT NULL AFTER org_id,
  ADD CONSTRAINT fk_dr_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  ADD KEY idx_dr_branch (org_id, branch_id, period_to);
