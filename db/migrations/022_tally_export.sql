-- 022_tally_export.sql
-- The other direction: this app's own books, handed to TallyPrime.
--
-- 021 reads a company's Tally into the portal. This is for the business that
-- bills here and whose accountant keeps the statutory books in Tally: every
-- invoice, bill, payment and journal we posted, written as Tally vouchers that
-- Tally imports.
--
-- Nothing about the export is stored as data — the vouchers are built from the
-- journal each time, so an export can never drift from the books. Two things
-- do need keeping:
--
--   the map    what each of our accounts is called in Tally, and which Tally
--              group it sits under. Only the ones a person changed: everything
--              else follows from the account's type, and a default that moves
--              with the chart of accounts is better than a stale copy of it.
--
--   the log    what was handed over and up to when, so the next export can
--              start where the last one stopped and nobody imports the same
--              month twice.

-- ── What our accounts are called in Tally ────────────────────────────────────
-- One row per account a person renamed or regrouped. No row means the default.
CREATE TABLE IF NOT EXISTS tally_ledger_map (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id             BIGINT       NOT NULL,
  account_id         BIGINT       NOT NULL,
  -- Tally's own limits: a ledger name is 100 characters, a group name likewise.
  ledger_name        VARCHAR(100) NOT NULL,
  parent_group       VARCHAR(100) NOT NULL,
  updated_by_user_id BIGINT       NULL,
  updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_tlm_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_tlm_account FOREIGN KEY (account_id) REFERENCES accounts(id),
  CONSTRAINT fk_tlm_user FOREIGN KEY (updated_by_user_id) REFERENCES users(id),
  UNIQUE KEY uq_tlm_account (org_id, account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── What has been handed over ────────────────────────────────────────────────
-- A note per file downloaded. It answers "what did the accountant already get,
-- and up to when" — the question that decides where the next export starts.
CREATE TABLE IF NOT EXISTS tally_exports (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT      NOT NULL,
  -- Null means every branch in one file.
  branch_id           BIGINT      NULL,
  kind                ENUM('masters','vouchers') NOT NULL,
  from_date           DATE        NOT NULL,
  to_date             DATE        NOT NULL,
  voucher_count       INT         NOT NULL DEFAULT 0,
  ledger_count        INT         NOT NULL DEFAULT 0,
  exported_by_user_id BIGINT      NULL,
  created_at          TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_texp_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_texp_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_texp_user FOREIGN KEY (exported_by_user_id) REFERENCES users(id),
  KEY idx_texp_org (org_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
