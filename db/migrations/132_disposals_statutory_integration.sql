-- 132_disposals_statutory_integration.sql
-- Status review 7, items 9, 10 and 14: the asset disposal workflow, the payroll
-- statutory reports, and the payroll and inventory integration check.

-- ── 9. Asset disposals ──────────────────────────────────────────────────────
--
-- Every disposal is kept as a record of its own, so one that was undone stays
-- on file beside the one that replaced it, with who undid it and why. The
-- columns on fixed_assets (disposed_on, disposal_kind…) keep saying what the
-- asset's state is now; this table says how it got there.
--
-- A disposal is sold (by a tax invoice to a buyer, or for money received
-- straight into a bank, where no GST applies) or scrapped. It posts two
-- entries: the depreciation from the last run to the day before it left
-- (Companies Act, Schedule II: depreciation stops when an asset is disposed of),
-- and one disposal entry — Dr Accumulated Depreciation, Dr the proceeds
-- (Asset Disposal Clearing for an invoiced sale, the bank for a direct one),
-- Cr the asset's cost, the gain or loss to Profit on Sale / Loss on Sale of
-- Fixed Assets. A book that wants a second person to approve a disposal keeps
-- it 'pending' with nothing posted until they do.
CREATE TABLE IF NOT EXISTS asset_disposals (
  id                     BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id                 BIGINT        NOT NULL,
  asset_id               BIGINT        NOT NULL,
  status                 ENUM('pending','posted','undone','rejected') NOT NULL DEFAULT 'posted',
  disposed_on            DATE          NOT NULL,
  kind                   ENUM('sold','scrapped') NOT NULL,
  proceeds_via           ENUM('invoice','bank','none') NOT NULL DEFAULT 'none',
  customer_id            BIGINT        NULL,
  bank_account_id        BIGINT        NULL,
  sale_value             DECIMAL(19,4) NOT NULL DEFAULT 0,
  gst_rate_pct           DECIMAL(5,2)  NULL,
  gst_amount             DECIMAL(19,4) NOT NULL DEFAULT 0,
  invoice_id             BIGINT        NULL,
  -- What the asset carried when it left: cost, depreciation to the day before
  -- (including what this disposal charged), and the gain (negative: a loss).
  cost                   DECIMAL(19,4) NOT NULL DEFAULT 0,
  accumulated            DECIMAL(19,4) NOT NULL DEFAULT 0,
  catch_up               DECIMAL(19,4) NOT NULL DEFAULT 0,
  gain                   DECIMAL(19,4) NOT NULL DEFAULT 0,
  depreciation_entry_id  BIGINT        NULL,
  disposal_entry_id      BIGINT        NULL,
  -- A part disposed of: the asset it was split from (the rest stays in use).
  part_of_asset_id       BIGINT        NULL,
  part_pct               DECIMAL(7,4)  NULL,
  reason                 VARCHAR(300)  NULL,
  requested_by_user_id   BIGINT        NULL,
  requested_at           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_by_user_id    BIGINT        NULL,
  approved_at            DATETIME      NULL,
  rejected_reason        VARCHAR(300)  NULL,
  undone_by_user_id      BIGINT        NULL,
  undone_at              DATETIME      NULL,
  undo_reason            VARCHAR(300)  NULL,
  CONSTRAINT fk_adisp_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_adisp_asset FOREIGN KEY (asset_id) REFERENCES fixed_assets(id),
  CONSTRAINT fk_adisp_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id),
  CONSTRAINT fk_adisp_bank FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id),
  CONSTRAINT fk_adisp_dep FOREIGN KEY (depreciation_entry_id) REFERENCES journal_entries(id),
  CONSTRAINT fk_adisp_entry FOREIGN KEY (disposal_entry_id) REFERENCES journal_entries(id),
  KEY idx_adisp_asset (asset_id, status),
  KEY idx_adisp_date (org_id, status, disposed_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Who must approve a disposal before it posts, if anyone: disposals whose
-- written-down value or proceeds reach the threshold wait for a person with
-- the role (an admin may always approve), never the person who asked.
CREATE TABLE IF NOT EXISTS asset_disposal_approval (
  org_id          BIGINT        NOT NULL PRIMARY KEY,
  is_active       TINYINT(1)    NOT NULL DEFAULT 0,
  threshold       DECIMAL(19,4) NOT NULL DEFAULT 0,
  approver_role   VARCHAR(30)   NOT NULL DEFAULT 'admin',
  updated_by_user_id BIGINT     NULL,
  updated_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_adappr_org FOREIGN KEY (org_id) REFERENCES organizations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Splitting an asset (Ind AS 16 / AS 10 componentisation, and the way part of
-- an asset is disposed of): part of the cost, and the same share of the
-- depreciation charged on it, move to a new asset. The cost moves as a
-- negative row on the old asset and a positive one on the new, so every sum
-- over asset_costs stays right; nothing posts, as the cost stays in the same
-- ledger.
ALTER TABLE asset_costs DROP CONSTRAINT ck_acost_amount;
ALTER TABLE asset_costs
  MODIFY COLUMN kind ENUM('purchase','addition','opening','split') NOT NULL DEFAULT 'purchase',
  ADD CONSTRAINT ck_acost_amount_nz CHECK (amount <> 0);

ALTER TABLE fixed_assets
  ADD COLUMN split_from_asset_id BIGINT NULL AFTER notes,
  ADD COLUMN disposal_id BIGINT NULL AFTER disposal_entry_id,
  -- The asset's own method, where it differs from its class's (Schedule II
  -- lets each asset be written off by straight line or written-down value).
  ADD COLUMN method ENUM('slm','wdv') NULL AFTER useful_life_years;

-- Depreciation posted outside a run (to a disposal's date, or the days an
-- asset missed while a disposal later undone had it out of the register)
-- names its own entry, so undoing it reverses exactly that.
ALTER TABLE depreciation_lines
  ADD COLUMN journal_entry_id BIGINT NULL AFTER reversed,
  ADD COLUMN split TINYINT(1) NOT NULL DEFAULT 0 AFTER journal_entry_id;

-- Disposals made before this file become records too, so they show in the
-- report the same way and can be undone: the depreciation entry their
-- disposal posted is found by the memo it was posted with.
INSERT INTO asset_disposals (org_id, asset_id, status, disposed_on, kind, proceeds_via, sale_value, invoice_id,
                             cost, accumulated, catch_up, gain, depreciation_entry_id, disposal_entry_id, reason)
SELECT a.org_id, a.id, 'posted', a.disposed_on, a.disposal_kind,
       IF(a.disposal_invoice_id IS NULL, 'none', 'invoice'), COALESCE(a.disposal_value, 0), a.disposal_invoice_id,
       COALESCE((SELECT SUM(c.amount) FROM asset_costs c WHERE c.asset_id = a.id), 0),
       a.opening_accumulated + COALESCE((SELECT SUM(d.amount) FROM depreciation_lines d WHERE d.asset_id = a.id AND d.reversed = 0), 0),
       COALESCE((SELECT SUM(d.amount) FROM depreciation_lines d WHERE d.asset_id = a.id AND d.reversed = 0 AND d.disposal = 1), 0),
       0,
       (SELECT e.id FROM journal_entries e
         WHERE e.org_id = a.org_id AND e.source_type = 'depreciation' AND e.source_id IS NULL
           AND e.memo = CONCAT('Depreciation on ', a.name, ' (', a.tag_no, ') to the day it left')
         ORDER BY e.id DESC LIMIT 1),
       a.disposal_entry_id, 'Disposed of before disposals were kept as records'
  FROM fixed_assets a
 WHERE a.status = 'disposed' AND a.disposal_kind IS NOT NULL AND a.disposed_on IS NOT NULL;

UPDATE asset_disposals SET gain = sale_value + accumulated - cost
 WHERE reason = 'Disposed of before disposals were kept as records';

UPDATE fixed_assets a JOIN asset_disposals d ON d.asset_id = a.id AND d.status = 'posted'
   SET a.disposal_id = d.id
 WHERE a.status = 'disposed';

UPDATE depreciation_lines l JOIN asset_disposals d ON d.asset_id = l.asset_id
   SET l.journal_entry_id = d.depreciation_entry_id
 WHERE l.disposal = 1 AND l.reversed = 0 AND l.journal_entry_id IS NULL AND d.depreciation_entry_id IS NOT NULL;

-- ── 10. Payroll statutory reports ───────────────────────────────────────────
--
-- TDS on salary (section 192 of the Income-tax Act, 1961; section 392 of the
-- 2025 Act) is deposited by challan ITNS 281 under nature of payment 92B, and
-- reported each quarter in Form 24Q (Form 138 from April 2026): Annexure I
-- lists every deduction against the challan that paid it, Annexure II (fourth
-- quarter) the year's salary of each employee. TRACES matches the challan's
-- BSR code, date and serial number with the bank's record, so they are kept
-- exactly, apart from the challans for non-salary TDS (tds_challans), which go
-- in a different return.
CREATE TABLE IF NOT EXISTS salary_tds_challans (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id             BIGINT        NOT NULL,
  for_month          CHAR(7)       NOT NULL,
  challan_date       DATE          NOT NULL,
  bsr_code           CHAR(7)       NOT NULL,
  challan_serial     VARCHAR(5)    NOT NULL,
  tax                DECIMAL(19,4) NOT NULL DEFAULT 0,
  surcharge          DECIMAL(19,4) NOT NULL DEFAULT 0,
  cess               DECIMAL(19,4) NOT NULL DEFAULT 0,
  interest           DECIMAL(19,4) NOT NULL DEFAULT 0,
  fee                DECIMAL(19,4) NOT NULL DEFAULT 0,
  total              DECIMAL(19,4) NOT NULL,
  bank_account_id    BIGINT        NOT NULL,
  journal_entry_id   BIGINT        NULL,
  notes              VARCHAR(300)  NULL,
  created_by_user_id BIGINT        NULL,
  created_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_stc_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_stc_bank FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id),
  CONSTRAINT fk_stc_entry FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id),
  CONSTRAINT ck_stc_total CHECK (total = tax + surcharge + cess + interest + fee),
  UNIQUE KEY uq_stc (org_id, bsr_code, challan_date, challan_serial),
  KEY idx_stc_month (org_id, for_month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which employee's deduction for which month a challan paid. Keyed by employee
-- and month, not payroll line, so a run reopened and posted again keeps its links.
CREATE TABLE IF NOT EXISTS salary_tds_links (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id       BIGINT        NOT NULL,
  challan_id   BIGINT        NOT NULL,
  employee_id  BIGINT        NOT NULL,
  month        CHAR(7)       NOT NULL,
  amount       DECIMAL(19,4) NOT NULL,
  CONSTRAINT fk_stl_challan FOREIGN KEY (challan_id) REFERENCES salary_tds_challans(id) ON DELETE CASCADE,
  CONSTRAINT fk_stl_emp FOREIGN KEY (employee_id) REFERENCES employees(id),
  CONSTRAINT ck_stl_amount CHECK (amount > 0),
  UNIQUE KEY uq_stl (challan_id, employee_id, month),
  KEY idx_stl_emp (org_id, employee_id, month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The receipt number TRACES gives each quarter's 24Q once it is filed: Form 16
-- Part A quotes it.
CREATE TABLE IF NOT EXISTS salary_tds_returns (
  org_id       BIGINT       NOT NULL,
  fy_start     SMALLINT     NOT NULL,
  quarter      TINYINT      NOT NULL,
  receipt_no   VARCHAR(20)  NOT NULL,
  filed_on     DATE         NULL,
  updated_by_user_id BIGINT NULL,
  updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id, fy_start, quarter),
  CONSTRAINT fk_str_org FOREIGN KEY (org_id) REFERENCES organizations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Salaries paid employee by employee: one row per employee per payment, so
-- Salaries Payable clears person by person and one payment can be taken back
-- without the rest. Paying everyone at once still posts one bank entry (one
-- line on the statement), its rows all naming it.
CREATE TABLE IF NOT EXISTS payroll_payments (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id             BIGINT        NOT NULL,
  run_id             BIGINT        NOT NULL,
  employee_id        BIGINT        NOT NULL,
  amount             DECIMAL(19,4) NOT NULL,
  paid_on            DATE          NOT NULL,
  bank_account_id    BIGINT        NOT NULL,
  reference          VARCHAR(60)   NULL,
  journal_entry_id   BIGINT        NOT NULL,
  reversed           TINYINT(1)    NOT NULL DEFAULT 0,
  reversal_entry_id  BIGINT        NULL,
  reversed_at        DATETIME      NULL,
  reverse_reason     VARCHAR(300)  NULL,
  created_by_user_id BIGINT        NULL,
  created_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ppay_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_ppay_run FOREIGN KEY (run_id) REFERENCES payroll_runs(id) ON DELETE CASCADE,
  CONSTRAINT fk_ppay_emp FOREIGN KEY (employee_id) REFERENCES employees(id),
  CONSTRAINT fk_ppay_bank FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id),
  CONSTRAINT fk_ppay_entry FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id),
  CONSTRAINT ck_ppay_amount CHECK (amount > 0),
  KEY idx_ppay_run (run_id, employee_id, reversed)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The state an employee works in, for Professional Tax and the Labour Welfare
-- Fund: both are levied by the state where the work is done, which need not
-- be the state of the GST registration the employee is kept under. Blank
-- means the branch's own state, as before.
ALTER TABLE employees
  ADD COLUMN work_state_code CHAR(2) NULL AFTER branch_id,
  -- The cost centre (department or division) whose salary expense this is.
  ADD COLUMN cost_centre_id BIGINT NULL AFTER department,
  ADD CONSTRAINT fk_emp_cc FOREIGN KEY (cost_centre_id) REFERENCES cost_centres(id);

-- ── 14. Payroll from an external payroll system ─────────────────────────────
--
-- A business that runs payroll in greytHR, Keka, Zoho Payroll or a bureau
-- imports the month's salary register; it posts the same salary journal a pay
-- run here would, and the integration check reconciles it with the ledger.
CREATE TABLE IF NOT EXISTS payroll_imports (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id             BIGINT        NOT NULL,
  month              CHAR(7)       NOT NULL,
  source_system      VARCHAR(60)   NULL,
  file_name          VARCHAR(200)  NULL,
  employees          INT           NOT NULL DEFAULT 0,
  gross              DECIMAL(19,4) NOT NULL DEFAULT 0,
  employer_cost      DECIMAL(19,4) NOT NULL DEFAULT 0,
  pf                 DECIMAL(19,4) NOT NULL DEFAULT 0,
  esi                DECIMAL(19,4) NOT NULL DEFAULT 0,
  pt                 DECIMAL(19,4) NOT NULL DEFAULT 0,
  lwf                DECIMAL(19,4) NOT NULL DEFAULT 0,
  tds                DECIMAL(19,4) NOT NULL DEFAULT 0,
  advances           DECIMAL(19,4) NOT NULL DEFAULT 0,
  net_pay            DECIMAL(19,4) NOT NULL DEFAULT 0,
  status             ENUM('posted','reversed') NOT NULL DEFAULT 'posted',
  journal_entry_id   BIGINT        NULL,
  reversal_entry_id  BIGINT        NULL,
  reverse_reason     VARCHAR(300)  NULL,
  created_by_user_id BIGINT        NULL,
  created_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pimp_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_pimp_entry FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id),
  KEY idx_pimp_month (org_id, month, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payroll_import_lines (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  import_id      BIGINT        NOT NULL,
  employee_code  VARCHAR(30)   NOT NULL,
  employee_name  VARCHAR(150)  NOT NULL,
  department     VARCHAR(100)  NULL,
  basic          DECIMAL(19,4) NOT NULL DEFAULT 0,
  hra            DECIMAL(19,4) NOT NULL DEFAULT 0,
  other_earnings DECIMAL(19,4) NOT NULL DEFAULT 0,
  gross          DECIMAL(19,4) NOT NULL DEFAULT 0,
  pf_employee    DECIMAL(19,4) NOT NULL DEFAULT 0,
  pf_employer    DECIMAL(19,4) NOT NULL DEFAULT 0,
  esi_employee   DECIMAL(19,4) NOT NULL DEFAULT 0,
  esi_employer   DECIMAL(19,4) NOT NULL DEFAULT 0,
  pt             DECIMAL(19,4) NOT NULL DEFAULT 0,
  lwf_employee   DECIMAL(19,4) NOT NULL DEFAULT 0,
  lwf_employer   DECIMAL(19,4) NOT NULL DEFAULT 0,
  tds            DECIMAL(19,4) NOT NULL DEFAULT 0,
  advance        DECIMAL(19,4) NOT NULL DEFAULT 0,
  net_pay        DECIMAL(19,4) NOT NULL DEFAULT 0,
  CONSTRAINT fk_piml_import FOREIGN KEY (import_id) REFERENCES payroll_imports(id) ON DELETE CASCADE,
  KEY idx_piml_import (import_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
