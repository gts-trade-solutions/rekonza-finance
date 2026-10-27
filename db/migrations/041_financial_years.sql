-- Closing a financial year.
--
-- The ledger is one continuous record, so a year's balances carry into the
-- next without being moved, and the year's profit reaches retained earnings in
-- the balance sheet without a closing entry. What closing adds is a decision:
-- the year is checked, every module is locked to its last day, and what the
-- books said at that moment is kept — the trial balance, the profit and the
-- closing stock — so a later question about the closed year can be answered
-- from the record of it rather than recomputed. Reopening is allowed, with a
-- reason, and leaves its own trace.

CREATE TABLE IF NOT EXISTS financial_years (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  -- The calendar year the financial year starts in: 2026 for 2026-27.
  fy_start            SMALLINT      NOT NULL,
  status              ENUM('open','closed') NOT NULL DEFAULT 'open',
  closed_at           TIMESTAMP     NULL,
  closed_by_user_id   BIGINT        NULL,
  net_profit          DECIMAL(19,4) NULL,
  closing_stock       DECIMAL(19,4) NULL,
  -- The trial balance at the year end, as it stood when the year was closed.
  snapshot            JSON          NULL,
  override_reason     VARCHAR(300)  NULL,
  reopened_at         TIMESTAMP     NULL,
  reopened_by_user_id BIGINT        NULL,
  reopen_reason       VARCHAR(300)  NULL,
  CONSTRAINT fk_fy_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_fy (org_id, fy_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
