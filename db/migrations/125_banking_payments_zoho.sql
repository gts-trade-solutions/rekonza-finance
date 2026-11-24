-- What Zoho Books has in Banking, Retainer Invoices and Recurring Invoices that
-- the first copies left out.
--
-- Banking Preferences (Zoho's More → Preferences): whether rules and matching
-- run when a statement comes in, how many days apart a payment and its
-- statement line may be and still be matched, the accounts a line is offered
-- for categorising first, whether the Payment Clearing tile shows, and whether
-- a duplicate line is kept as "Automatically Excluded" rather than dropped.
-- One row per organisation; no row means the defaults below.

CREATE TABLE IF NOT EXISTS banking_preferences (
  org_id                      BIGINT        NOT NULL PRIMARY KEY,
  apply_rules_on_import       TINYINT(1)    NOT NULL DEFAULT 1,
  auto_match_on_import        TINYINT(1)    NOT NULL DEFAULT 1,
  match_window_days           SMALLINT      NOT NULL DEFAULT 3,
  default_expense_account_id  BIGINT        NULL,
  default_income_account_id   BIGINT        NULL,
  show_payment_clearing       TINYINT(1)    NOT NULL DEFAULT 1,
  keep_duplicates             TINYINT(1)    NOT NULL DEFAULT 1,
  -- "Auto-upload bank statements from email": statements forwarded to an
  -- account's own address are imported, but only from these senders (and the
  -- organisation's own users), so a stranger who learns the address cannot
  -- put lines into the books.
  inbound_enabled             TINYINT(1)    NOT NULL DEFAULT 1,
  inbound_senders             VARCHAR(1000) NULL,
  updated_at                  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_bankpref_org FOREIGN KEY (org_id) REFERENCES organizations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Each bank account's forwarding address: statements+<token>@<inbound domain>.
ALTER TABLE bank_accounts
  ADD COLUMN inbound_token VARCHAR(32) NULL AFTER user_ids,
  ADD UNIQUE KEY uq_bank_inbound_token (inbound_token);

-- A line excluded because it repeats one already imported (Zoho's
-- "Automatically Excluded"), as against one a person took out.
ALTER TABLE bank_transactions
  ADD COLUMN auto_excluded TINYINT(1) NOT NULL DEFAULT 0 AFTER exclude_reason;

-- Every statement that arrived by email, imported or refused, and why: Zoho's
-- "Bank Statements From Inbox".
CREATE TABLE IF NOT EXISTS inbound_statements (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id           BIGINT        NOT NULL,
  bank_account_id  BIGINT        NULL,
  provider         VARCHAR(20)   NOT NULL,
  sender           VARCHAR(255)  NULL,
  recipient        VARCHAR(255)  NULL,
  subject          VARCHAR(255)  NULL,
  filename         VARCHAR(255)  NULL,
  status           ENUM('imported','refused','failed') NOT NULL,
  rows_imported    INT           NOT NULL DEFAULT 0,
  rows_duplicate   INT           NOT NULL DEFAULT 0,
  import_id        BIGINT        NULL,
  error            VARCHAR(500)  NULL,
  received_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_inbound_org (org_id, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A paid retainer's unapplied money paid back to the customer (Zoho's ⋯ → Refund).
ALTER TABLE retainer_invoices
  ADD COLUMN refunded_amount DECIMAL(19,4) NOT NULL DEFAULT 0 AFTER applied_amount;

-- A recurring profile's Select Price List, Associate Project(s) Hours and
-- Associate Payment Options (a payment link on each invoice it raises).
ALTER TABLE recurring_invoices
  ADD COLUMN price_list_id  BIGINT     NULL AFTER salesperson_id,
  ADD COLUMN project_ids    JSON       NULL AFTER price_list_id,
  ADD COLUMN payment_link   TINYINT(1) NOT NULL DEFAULT 0 AFTER create_as_draft;
