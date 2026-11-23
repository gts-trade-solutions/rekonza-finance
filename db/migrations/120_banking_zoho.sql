-- Zoho Books' Banking, field for field.
--
-- An account: Zoho's "Add Bank or Credit Card" asks for an account code, the
-- currency the account is held in, a description and which users may see it
-- (no users chosen: everyone with the banking right may).
--
-- A rule: Zoho's "New Rules" form. It applies to deposits or to withdrawals;
-- it either only recognises a line (offers the categorisation for a person to
-- accept) or categorises it outright; its criteria all have to match or any
-- one may; it records the line as one of Zoho's categories (an expense, a
-- deposit, a transfer …) into an account; the reference comes from the
-- statement or is left blank; and it runs on all accounts, all banks, all
-- cards, or a chosen few. A rule written before this keeps working: the
-- defaults below are what it already did (every criterion, both directions,
-- the one account it named, or all).
--
-- A statement line taken out of the reconciliation keeps why (Zoho's REASON
-- column under Excluded).

ALTER TABLE bank_accounts
  ADD COLUMN account_code VARCHAR(30)  NULL AFTER name,
  ADD COLUMN currency     CHAR(3)      NOT NULL DEFAULT 'INR' AFTER account_code,
  ADD COLUMN description  VARCHAR(500) NULL AFTER ifsc,
  ADD COLUMN user_ids     JSON         NULL AFTER description;

ALTER TABLE bank_rules
  ADD COLUMN apply_to          VARCHAR(12)  NULL AFTER name,
  ADD COLUMN match_mode        VARCHAR(4)   NOT NULL DEFAULT 'all' AFTER apply_to,
  ADD COLUMN record_as         VARCHAR(40)  NULL AFTER conditions,
  ADD COLUMN reference_mode    VARCHAR(12)  NOT NULL DEFAULT 'statement' AFTER record_as,
  ADD COLUMN account_scope     VARCHAR(8)   NOT NULL DEFAULT 'all' AFTER reference_mode,
  ADD COLUMN scope_account_ids JSON         NULL AFTER account_scope,
  ADD COLUMN other_bank_account_id BIGINT NULL AFTER action_account_id;

-- A rule that named one bank account is a Custom rule on that account.
UPDATE bank_rules
   SET account_scope = 'custom', scope_account_ids = JSON_ARRAY(bank_account_id)
 WHERE bank_account_id IS NOT NULL;

ALTER TABLE bank_transactions
  ADD COLUMN exclude_reason VARCHAR(255) NULL AFTER status;
