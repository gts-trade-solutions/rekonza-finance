-- 006_payments_banking.sql
-- Payments and their allocations, bank accounts, statement lines, rules,
-- cheques and transfers.
--
-- A payment is deliberately separate from what it settles. One receipt can
-- clear three invoices and leave change on account; one payment run can settle
-- twenty bills. Storing the link on the invoice instead would make both of
-- those impossible to represent honestly.

CREATE TABLE IF NOT EXISTS payments (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  branch_id         BIGINT        NOT NULL,
  number            VARCHAR(50)   NOT NULL,
  kind              ENUM('received','made') NOT NULL,
  contact_id        BIGINT        NOT NULL,
  payment_date      DATE          NOT NULL,
  mode              ENUM('cash','cheque','neft','rtgs','imps','upi','card','netbanking','other') NOT NULL DEFAULT 'neft',
  -- Gross: what the customer parted with, before TDS they withheld.
  amount            DECIMAL(19,4) NOT NULL DEFAULT 0,
  bank_account_id   BIGINT        NOT NULL,
  reference         VARCHAR(150)  NULL,
  -- On a receipt this is TDS the customer deducted from us; on a payment it is
  -- TDS we withheld from the vendor. Either way it settles the document but
  -- never reaches a bank account, which is why it cannot be netted into amount.
  tds_amount        DECIMAL(19,4) NOT NULL DEFAULT 0,
  bank_charges      DECIMAL(19,4) NOT NULL DEFAULT 0,
  -- Money received that has not been matched to a document yet: an advance.
  unapplied_amount  DECIMAL(19,4) NOT NULL DEFAULT 0,
  status            ENUM('cleared','void') NOT NULL DEFAULT 'cleared',
  notes             VARCHAR(1000) NULL,
  journal_entry_id  BIGINT        NULL,
  created_by_user_id BIGINT       NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_pay_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_pay_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_pay_contact FOREIGN KEY (contact_id) REFERENCES contacts(id),
  CONSTRAINT fk_pay_entry FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id),
  UNIQUE KEY uq_pay_org_number (org_id, number),
  KEY idx_pay_org_date (org_id, kind, payment_date),
  KEY idx_pay_contact (org_id, contact_id, payment_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payment_allocations (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id        BIGINT        NOT NULL,
  payment_id    BIGINT        NOT NULL,
  -- Polymorphic on purpose: a payment can settle any of five document kinds,
  -- and five nullable foreign keys would be worse than one typed pair.
  target_type   ENUM('invoice','bill','credit_note','vendor_credit','retainer') NOT NULL,
  target_id     BIGINT        NOT NULL,
  amount        DECIMAL(19,4) NOT NULL,
  CONSTRAINT fk_palloc_payment FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE,
  CONSTRAINT ck_palloc_positive CHECK (amount > 0),
  KEY idx_palloc_target (org_id, target_type, target_id),
  KEY idx_palloc_payment (payment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bank_accounts (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  kind              ENUM('bank','card','cash','wallet','clearing') NOT NULL DEFAULT 'bank',
  name              VARCHAR(150)  NOT NULL,
  bank_name         VARCHAR(120)  NULL,
  account_last4     CHAR(4)       NULL,
  ifsc              VARCHAR(15)   NULL,
  -- Every bank account is also a ledger account. Keeping them as two rows
  -- linked by this column is what lets the reconciliation screen compare the
  -- statement against the books without guessing which account is which.
  ledger_account_id BIGINT        NOT NULL,
  opening_balance   DECIMAL(19,4) NOT NULL DEFAULT 0,
  opening_date      DATE          NULL,
  is_primary        TINYINT(1)    NOT NULL DEFAULT 0,
  -- Automatic feeds need a licensed aggregator, so this stays off until that
  -- integration exists. Statement import is the supported route today.
  feed_connected    TINYINT(1)    NOT NULL DEFAULT 0,
  is_active         TINYINT(1)    NOT NULL DEFAULT 1,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_ba_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_ba_ledger FOREIGN KEY (ledger_account_id) REFERENCES accounts(id),
  UNIQUE KEY uq_ba_ledger (ledger_account_id),
  KEY idx_ba_org (org_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bank_transactions (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  bank_account_id   BIGINT        NOT NULL,
  txn_date          DATE          NOT NULL,
  narration         VARCHAR(500)  NOT NULL,
  reference         VARCHAR(150)  NULL,
  deposit           DECIMAL(19,4) NOT NULL DEFAULT 0,
  withdrawal        DECIMAL(19,4) NOT NULL DEFAULT 0,
  running_balance   DECIMAL(19,4) NULL,
  status            ENUM('unmatched','matched','excluded','manually_added') NOT NULL DEFAULT 'unmatched',
  matched_type      VARCHAR(30)   NULL,
  matched_id        BIGINT        NULL,
  matched_at        DATETIME      NULL,
  matched_by_user_id BIGINT       NULL,
  applied_rule_id   BIGINT        NULL,
  import_batch_id   BIGINT        NULL,
  -- Re-importing an overlapping statement is normal. This fingerprint of the
  -- line lets the importer skip what is already there instead of doubling it.
  dedupe_hash       CHAR(64)      NOT NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_btx_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_btx_account FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id),
  CONSTRAINT ck_btx_direction CHECK (deposit >= 0 AND withdrawal >= 0 AND (deposit = 0 OR withdrawal = 0)),
  UNIQUE KEY uq_btx_dedupe (bank_account_id, dedupe_hash),
  KEY idx_btx_account_date (org_id, bank_account_id, txn_date),
  KEY idx_btx_status (org_id, status, txn_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bank_statement_imports (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  bank_account_id   BIGINT        NOT NULL,
  filename          VARCHAR(255)  NOT NULL,
  file_id           BIGINT        NULL,
  rows_total        INT           NOT NULL DEFAULT 0,
  rows_imported     INT           NOT NULL DEFAULT 0,
  rows_duplicate    INT           NOT NULL DEFAULT 0,
  period_from       DATE          NULL,
  period_to         DATE          NULL,
  imported_by_user_id BIGINT      NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_bsi_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_bsi_account FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id),
  KEY idx_bsi_org (org_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bank_rules (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  name              VARCHAR(150)  NOT NULL,
  priority          SMALLINT      NOT NULL DEFAULT 100,
  bank_account_id   BIGINT        NULL,
  -- [{ field, op, value }] — kept as JSON because the rule shape is user data,
  -- not schema, and a conditions table would be joined only to be re-assembled.
  conditions        JSON          NOT NULL,
  action_account_id BIGINT        NULL,
  contact_id        BIGINT        NULL,
  -- Auto-confirm posts the match without review. Off by default, because a
  -- rule that silently miscategorises is worse than one that asks.
  auto_confirm      TINYINT(1)    NOT NULL DEFAULT 0,
  is_active         TINYINT(1)    NOT NULL DEFAULT 1,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_br_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_br_account FOREIGN KEY (action_account_id) REFERENCES accounts(id),
  CONSTRAINT fk_br_contact FOREIGN KEY (contact_id) REFERENCES contacts(id),
  KEY idx_br_org (org_id, is_active, priority)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bank_transfers (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  from_bank_account_id BIGINT     NOT NULL,
  to_bank_account_id BIGINT       NOT NULL,
  transfer_date     DATE          NOT NULL,
  amount            DECIMAL(19,4) NOT NULL,
  reference         VARCHAR(150)  NULL,
  journal_entry_id  BIGINT        NULL,
  created_by_user_id BIGINT       NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_bt_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_bt_from FOREIGN KEY (from_bank_account_id) REFERENCES bank_accounts(id),
  CONSTRAINT fk_bt_to FOREIGN KEY (to_bank_account_id) REFERENCES bank_accounts(id),
  CONSTRAINT fk_bt_entry FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id),
  CONSTRAINT ck_bt_distinct CHECK (from_bank_account_id <> to_bank_account_id),
  KEY idx_bt_org_date (org_id, transfer_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Post-dated cheques are still normal in Indian trade. A PDC is a commitment
-- with a maturity date, not yet a bank movement.
CREATE TABLE IF NOT EXISTS cheques (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  kind              ENUM('issued','received') NOT NULL,
  contact_id        BIGINT        NOT NULL,
  cheque_no         VARCHAR(20)   NOT NULL,
  bank_name         VARCHAR(120)  NULL,
  amount            DECIMAL(19,4) NOT NULL,
  is_pdc            TINYINT(1)    NOT NULL DEFAULT 0,
  maturity_date     DATE          NOT NULL,
  status            ENUM('in_hand','deposited','cleared','bounced','cancelled') NOT NULL DEFAULT 'in_hand',
  payment_id        BIGINT        NULL,
  notes             VARCHAR(500)  NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_chq_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_chq_contact FOREIGN KEY (contact_id) REFERENCES contacts(id),
  CONSTRAINT fk_chq_payment FOREIGN KEY (payment_id) REFERENCES payments(id),
  KEY idx_chq_org_maturity (org_id, kind, maturity_date),
  KEY idx_chq_status (org_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
