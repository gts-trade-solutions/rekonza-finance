-- Status review 7, builder A: consolidation groups, a tamper-evident audit
-- trail, voucher reversals with reasons, period budgets, and nothing for the
-- custom report filters (they reuse saved_views).
--
-- Every table carries org_id so that wiping a company (the demo seed's
-- --fresh, lib/server/seed/wipe.ts) clears its rows with it.

-- ── 1. Consolidation (AS 21 / Ind AS 110) ───────────────────────────────────
-- A group is set up from its parent company: org_id is the parent. Each
-- subsidiary is a member with the parent's share in it, so non-controlling
-- interest can be shown when it is below 100%, and the account in the
-- parent's books that holds the investment in it, so the investment can be
-- set against the subsidiary's share capital.
CREATE TABLE IF NOT EXISTS consolidation_groups (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  name                VARCHAR(200)  NOT NULL,
  created_by_user_id  BIGINT        NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_cgrp_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_cgrp_parent (org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- member_org_id has no foreign key on purpose: a member company that is
-- wiped (the demo's second company) must not stop its parent's set-up from
-- being read; the code leaves out members it cannot find.
CREATE TABLE IF NOT EXISTS consolidation_members (
  id                     BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id                 BIGINT        NOT NULL,
  group_id               BIGINT        NOT NULL,
  member_org_id          BIGINT        NOT NULL,
  ownership_pct          DECIMAL(7,4)  NOT NULL DEFAULT 100,
  acquired_on            DATE          NULL,
  -- In the parent's books.
  investment_account_id  BIGINT        NULL,
  CONSTRAINT fk_cmem_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_cmem_group FOREIGN KEY (group_id) REFERENCES consolidation_groups(id) ON DELETE CASCADE,
  UNIQUE KEY uq_cmem (group_id, member_org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- "In this company, this customer or vendor is that group company", for when
-- the PANs do not say so (a company added without a PAN or GSTIN).
CREATE TABLE IF NOT EXISTS consolidation_contact_links (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  contact_id          BIGINT        NOT NULL,
  counterpart_org_id  BIGINT        NOT NULL,
  created_by_user_id  BIGINT        NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_cclink_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_cclink_contact FOREIGN KEY (contact_id) REFERENCES contacts(id),
  UNIQUE KEY uq_cclink (org_id, contact_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 2. The audit trail's hash chain (Companies (Accounts) Rules 2014, r. 3(1)) ─
-- Each audit row, once sealed, has a SHA-256 over its own content and the
-- hash before it. A row changed or removed behind the application's back
-- breaks the chain at that row. Kept beside audit_log, not in it, because
-- audit_log refuses UPDATE (db/protect) and a hash can only be worked out
-- after the row exists. seq is the seal order within the company.
CREATE TABLE IF NOT EXISTS audit_chain (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id      BIGINT        NOT NULL,
  seq         BIGINT        NOT NULL,
  audit_id    BIGINT        NOT NULL,
  prev_hash   CHAR(64)      NOT NULL,
  row_hash    CHAR(64)      NOT NULL,
  sealed_at   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_achain_audit (audit_id),
  UNIQUE KEY uq_achain_seq (org_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per company: the chain's last link, and the highest audit id sealed,
-- locked while a seal runs so two seals never fork the chain.
CREATE TABLE IF NOT EXISTS audit_chain_heads (
  org_id         BIGINT        NOT NULL PRIMARY KEY,
  last_seq       BIGINT        NOT NULL DEFAULT 0,
  last_hash      CHAR(64)      NOT NULL,
  max_audit_id   BIGINT        NOT NULL DEFAULT 0,
  verified_at    TIMESTAMP(3)  NULL,
  verified_ok    TINYINT(1)    NULL,
  updated_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 4. Voucher reversals ────────────────────────────────────────────────────
-- A held entry can be the reversal of a posted one: waiting for a second
-- person under a journal approval rule (kind 'approval'), or due on a later
-- date as an auto-reversing accrual (kind 'post_dated'). Released, it reverses
-- that entry rather than posting lines of its own.
ALTER TABLE held_journals
  ADD COLUMN reverses_entry_id BIGINT       NULL AFTER entry_id,
  ADD COLUMN reason            VARCHAR(500) NULL AFTER note,
  ADD KEY idx_hj_reverses (org_id, reverses_entry_id, status);

-- Every reversal posted from the journal screens, with why and by whom: the
-- Reversed vouchers register reads it beside journal_entries' own links.
CREATE TABLE IF NOT EXISTS journal_reversals (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id                BIGINT        NOT NULL,
  entry_id              BIGINT        NOT NULL,
  reversal_entry_id     BIGINT        NOT NULL,
  reverse_on            DATE          NOT NULL,
  reason                VARCHAR(500)  NOT NULL,
  -- manual: reversed by hand; approved: after a second person approved it;
  -- scheduled: an auto-reversing journal reversed on its date.
  kind                  ENUM('manual','approved','scheduled') NOT NULL DEFAULT 'manual',
  requested_by_user_id  BIGINT        NULL,
  approved_by_user_id   BIGINT        NULL,
  created_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_jrev_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_jrev_entry FOREIGN KEY (entry_id) REFERENCES journal_entries(id),
  CONSTRAINT fk_jrev_reversal FOREIGN KEY (reversal_entry_id) REFERENCES journal_entries(id),
  UNIQUE KEY uq_jrev_entry (entry_id),
  KEY idx_jrev_org (org_id, reverse_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 12. Budgets by period, as Zoho Books has them ───────────────────────────
-- A named budget for a financial year, entered month by month, by quarter,
-- by half year or for the year, for the whole business or one branch, cost
-- centre or project. Several can exist for a year ("Original", "Revised");
-- the primary one is what the assistant and the old yearly view read.
CREATE TABLE IF NOT EXISTS budget_plans (
  id                     BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id                 BIGINT        NOT NULL,
  name                   VARCHAR(120)  NOT NULL,
  fy_label               VARCHAR(7)    NOT NULL,
  period                 ENUM('monthly','quarterly','half_yearly','yearly') NOT NULL DEFAULT 'monthly',
  branch_id              BIGINT        NULL,
  cost_centre_id         BIGINT        NULL,
  project_id             BIGINT        NULL,
  include_balance_sheet  TINYINT(1)    NOT NULL DEFAULT 0,
  is_primary             TINYINT(1)    NOT NULL DEFAULT 0,
  notes                  VARCHAR(500)  NULL,
  created_by_user_id     BIGINT        NULL,
  created_at             TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_bplan_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_bplan_name (org_id, fy_label, name),
  KEY idx_bplan_fy (org_id, fy_label)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One amount per account per period of the plan: period_no 1..12 for a
-- monthly plan (1 = the first month of the year), 1..4 quarterly, 1..2 half
-- yearly, 1 yearly.
CREATE TABLE IF NOT EXISTS budget_plan_lines (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id      BIGINT        NOT NULL,
  plan_id     BIGINT        NOT NULL,
  account_id  BIGINT        NOT NULL,
  period_no   TINYINT       NOT NULL,
  amount      DECIMAL(19,4) NOT NULL DEFAULT 0,
  CONSTRAINT fk_bpl_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_bpl_plan FOREIGN KEY (plan_id) REFERENCES budget_plans(id) ON DELETE CASCADE,
  CONSTRAINT fk_bpl_account FOREIGN KEY (account_id) REFERENCES accounts(id),
  UNIQUE KEY uq_bpl (plan_id, account_id, period_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The yearly budgets kept so far become yearly plans, one per company, year
-- and branch, spread evenly by days when read month by month, exactly as the
-- old screen spread them. The old rows stay where they are.
INSERT INTO budget_plans (org_id, name, fy_label, period, branch_id, is_primary)
SELECT b.org_id,
       IF(b.branch_id = 0, 'Annual budget', CONCAT('Annual budget (branch ', b.branch_id, ')')),
       b.fy_label, 'yearly', NULLIF(b.branch_id, 0), IF(b.branch_id = 0, 1, 0)
  FROM budgets b
 GROUP BY b.org_id, b.fy_label, b.branch_id;

INSERT INTO budget_plan_lines (org_id, plan_id, account_id, period_no, amount)
SELECT b.org_id, p.id, b.account_id, 1, b.amount
  FROM budgets b
  JOIN budget_plans p
    ON p.org_id = b.org_id AND p.fy_label = b.fy_label AND p.period = 'yearly'
   AND COALESCE(p.branch_id, 0) = b.branch_id
   AND p.name = IF(b.branch_id = 0, 'Annual budget', CONCAT('Annual budget (branch ', b.branch_id, ')'));
