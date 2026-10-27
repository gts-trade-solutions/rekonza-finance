-- 012_budgets.sql
-- Budgets: a planned figure per account, per financial year.
--
-- Stored per account rather than per category so the variance report can be
-- built by joining straight onto the journal — the same account the actuals
-- posted to is the one the budget is set against, and there is no mapping in
-- between to drift.
--
-- Monthly splits are deliberately not modelled. Almost every SMB sets an annual
-- figure and watches the year-to-date position against it; a twelve-column grid
-- is a lot of data entry for a number nobody revisits.

CREATE TABLE IF NOT EXISTS budgets (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id        BIGINT        NOT NULL,
  branch_id     BIGINT        NULL,
  account_id    BIGINT        NOT NULL,
  -- '2026-27'. The label, not a date, because a budget belongs to a year.
  fy_label      VARCHAR(10)   NOT NULL,
  amount        DECIMAL(19,4) NOT NULL DEFAULT 0,
  notes         VARCHAR(500)  NULL,
  created_by_user_id BIGINT   NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_budget_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_budget_account FOREIGN KEY (account_id) REFERENCES accounts(id),
  CONSTRAINT ck_budget_amount CHECK (amount >= 0),
  -- One figure per account per year. A second row would silently double the
  -- budget without anyone noticing which one the report used.
  UNIQUE KEY uq_budget (org_id, fy_label, account_id, branch_id),
  KEY idx_budget_fy (org_id, fy_label)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
