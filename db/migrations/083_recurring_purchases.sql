-- Recurring bills and recurring expenses, and mileage.
--
-- The rent bill that comes every month, the internet charged to the card on
-- the 5th: a profile holds what each one is, and the scheduler (or "Run now")
-- raises it on its date through the same createBill / createExpense a person
-- would use, so its GST, TDS and posting are the hand-entered ones. As with
-- recurring invoices, the template is kept as written: a profile does not
-- quietly re-price itself when an item's purchase price moves.
--
-- A recurring bill is given a placeholder for the vendor's own bill number
-- (their number is not known until their bill arrives); the person replaces
-- it from the vendor's bill. Nothing is caught up: a profile that has fallen
-- more than a period behind is left for a person (scheduler.ts).

CREATE TABLE IF NOT EXISTS recurring_purchases (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  branch_id         BIGINT        NOT NULL,
  kind              ENUM('bill','expense') NOT NULL,
  profile_name      VARCHAR(200)  NOT NULL,
  vendor_id         BIGINT        NULL,
  frequency         ENUM('weekly','monthly','quarterly','yearly') NOT NULL DEFAULT 'monthly',
  start_date        DATE          NOT NULL,
  end_date          DATE          NULL,
  next_run          DATE          NOT NULL,
  -- Bills: days from the bill date to its due date.
  due_days          INT           NOT NULL DEFAULT 30,
  -- Expenses: the bank, cash or card account it is paid from.
  paid_through_bank_account_id BIGINT NULL,
  -- Bill lines, or the expense's account, amount and GST, as written.
  template          JSON          NOT NULL,
  auto_run          TINYINT(1)    NOT NULL DEFAULT 0,
  is_active         TINYINT(1)    NOT NULL DEFAULT 1,
  last_generated_at DATE          NULL,
  last_error        VARCHAR(500)  NULL,
  created_by_user_id BIGINT       NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_rp_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_rp_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_rp_vendor FOREIGN KEY (vendor_id) REFERENCES contacts(id),
  CONSTRAINT fk_rp_bank FOREIGN KEY (paid_through_bank_account_id) REFERENCES bank_accounts(id),
  KEY idx_rp_due (org_id, is_active, next_run)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which profile raised a bill or an expense.
ALTER TABLE bills    ADD COLUMN recurring_id BIGINT NULL;
ALTER TABLE expenses ADD COLUMN recurring_id BIGINT NULL;

-- Mileage: a journey claimed at a rate a kilometre. The expense is the
-- distance times the rate, with no GST in it (nobody charged any).
ALTER TABLE expenses
  ADD COLUMN mileage_km DECIMAL(10,2) NULL,
  ADD COLUMN mileage_rate DECIMAL(19,4) NULL;
