-- Payroll: employees, their salary structure, and monthly runs.
--
-- A run computes each employee's pay for a month from the structure in force,
-- the days paid, and the statutory deductions (lib/payroll/statutory.ts):
-- provident fund, ESI, professional tax, labour welfare fund and income tax on
-- salary. Posting it books the cost and what is owed to each authority;
-- paying it clears the net salaries from a bank account.

CREATE TABLE IF NOT EXISTS employees (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT       NOT NULL,
  branch_id           BIGINT       NOT NULL,
  code                VARCHAR(20)  NOT NULL,
  name                VARCHAR(150) NOT NULL,
  gender              ENUM('male','female','other') NULL,
  date_of_birth       DATE         NULL,
  date_of_joining     DATE         NOT NULL,
  date_of_leaving     DATE         NULL,
  designation         VARCHAR(100) NULL,
  department          VARCHAR(100) NULL,
  email               VARCHAR(150) NULL,
  mobile              VARCHAR(15)  NULL,
  pan                 CHAR(10)     NULL,
  uan                 VARCHAR(12)  NULL,
  esi_ip_number       VARCHAR(17)  NULL,
  pf_member           TINYINT(1)   NOT NULL DEFAULT 1,
  -- Members who joined after 1 September 2014 on more than 15,000 rupees are not in the pension scheme.
  eps_member          TINYINT(1)   NOT NULL DEFAULT 1,
  -- Contribute on the whole PF wage rather than the 15,000 rupee ceiling.
  pf_on_actual        TINYINT(1)   NOT NULL DEFAULT 0,
  pt_applicable       TINYINT(1)   NOT NULL DEFAULT 1,
  lwf_applicable      TINYINT(1)   NOT NULL DEFAULT 1,
  disabled            TINYINT(1)   NOT NULL DEFAULT 0,
  tax_regime          ENUM('new','old') NOT NULL DEFAULT 'new',
  -- Old regime only: the year's declared deductions and exemptions (80C, 80D, HRA...), in rupees.
  declared_deductions DECIMAL(19,4) NOT NULL DEFAULT 0,
  bank_account_name   VARCHAR(150) NULL,
  bank_account_no     VARCHAR(34)  NULL,
  bank_ifsc           CHAR(11)     NULL,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_emp_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_emp_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  UNIQUE KEY uq_emp_code (org_id, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The monthly structure, from a date. A raise is a new row, so a past month is
-- always recomputed on the pay it was actually earned at.
CREATE TABLE IF NOT EXISTS employee_salaries (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  employee_id     BIGINT        NOT NULL,
  effective_from  DATE          NOT NULL,
  basic           DECIMAL(19,4) NOT NULL,
  da              DECIMAL(19,4) NOT NULL DEFAULT 0,
  hra             DECIMAL(19,4) NOT NULL DEFAULT 0,
  special         DECIMAL(19,4) NOT NULL DEFAULT 0,
  other           DECIMAL(19,4) NOT NULL DEFAULT 0,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_esal_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  UNIQUE KEY uq_esal (employee_id, effective_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payroll_runs (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT       NOT NULL,
  month               CHAR(7)      NOT NULL,
  status              ENUM('draft','posted','paid') NOT NULL DEFAULT 'draft',
  journal_entry_id    BIGINT       NULL,
  paid_on             DATE         NULL,
  paid_from_bank_id   BIGINT       NULL,
  payment_entry_id    BIGINT       NULL,
  created_by_user_id  BIGINT       NULL,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_prun_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_prun_month (org_id, month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One employee's month. Inputs (days, extras) are kept beside every figure
-- worked out from them, so a payslip can always be reproduced as issued.
CREATE TABLE IF NOT EXISTS payroll_lines (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  run_id             BIGINT        NOT NULL,
  employee_id        BIGINT        NOT NULL,
  days_in_month      TINYINT       NOT NULL,
  lop_days           DECIMAL(4,1)  NOT NULL DEFAULT 0,
  paid_days          DECIMAL(4,1)  NOT NULL,
  basic              DECIMAL(19,4) NOT NULL DEFAULT 0,
  da                 DECIMAL(19,4) NOT NULL DEFAULT 0,
  hra                DECIMAL(19,4) NOT NULL DEFAULT 0,
  special            DECIMAL(19,4) NOT NULL DEFAULT 0,
  other              DECIMAL(19,4) NOT NULL DEFAULT 0,
  bonus              DECIMAL(19,4) NOT NULL DEFAULT 0,
  reimbursement      DECIMAL(19,4) NOT NULL DEFAULT 0,
  gross              DECIMAL(19,4) NOT NULL DEFAULT 0,
  pf_wage            DECIMAL(19,4) NOT NULL DEFAULT 0,
  eps_wage           DECIMAL(19,4) NOT NULL DEFAULT 0,
  pf_employee        DECIMAL(19,4) NOT NULL DEFAULT 0,
  pf_employer_epf    DECIMAL(19,4) NOT NULL DEFAULT 0,
  pf_employer_eps    DECIMAL(19,4) NOT NULL DEFAULT 0,
  pf_admin           DECIMAL(19,4) NOT NULL DEFAULT 0,
  pf_edli            DECIMAL(19,4) NOT NULL DEFAULT 0,
  esi_wage           DECIMAL(19,4) NOT NULL DEFAULT 0,
  esi_employee       DECIMAL(19,4) NOT NULL DEFAULT 0,
  esi_employer       DECIMAL(19,4) NOT NULL DEFAULT 0,
  pt                 DECIMAL(19,4) NOT NULL DEFAULT 0,
  lwf_employee       DECIMAL(19,4) NOT NULL DEFAULT 0,
  lwf_employer       DECIMAL(19,4) NOT NULL DEFAULT 0,
  tds                DECIMAL(19,4) NOT NULL DEFAULT 0,
  advance_recovery   DECIMAL(19,4) NOT NULL DEFAULT 0,
  net_pay            DECIMAL(19,4) NOT NULL DEFAULT 0,
  notes              VARCHAR(300)  NULL,
  CONSTRAINT fk_pline_run FOREIGN KEY (run_id) REFERENCES payroll_runs(id) ON DELETE CASCADE,
  CONSTRAINT fk_pline_emp FOREIGN KEY (employee_id) REFERENCES employees(id),
  UNIQUE KEY uq_pline (run_id, employee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE organizations
  ADD COLUMN pf_establishment_code VARCHAR(30) NULL,
  ADD COLUMN esi_employer_code     VARCHAR(30) NULL;

INSERT INTO accounts (org_id, code, name, type, subtype, description, is_system, is_active)
SELECT o.id, x.code, x.name, x.type, x.subtype, x.description, 1, 1
  FROM organizations o
  JOIN (
    SELECT '2320' AS code, 'PF Payable' AS name, 'liability' AS type, 'current' AS subtype,
           'Provident fund deducted and contributed, due to EPFO by the 15th' AS description
    UNION ALL SELECT '2330', 'ESI Payable', 'liability', 'current', 'ESI deducted and contributed, due to ESIC by the 15th'
    UNION ALL SELECT '2340', 'Professional Tax Payable', 'liability', 'current', 'Professional tax deducted from salaries, due to the state'
    UNION ALL SELECT '2350', 'Labour Welfare Fund Payable', 'liability', 'current', 'Employee and employer labour welfare fund contributions'
    UNION ALL SELECT '2410', 'Salaries Payable', 'liability', 'current', 'Net salaries for a posted payroll, until they are paid'
    UNION ALL SELECT '6210', 'Employer PF, ESI and LWF', 'expense', NULL, 'The employer contributions and PF charges on salaries'
    UNION ALL SELECT '6220', 'Staff Reimbursements', 'expense', NULL, 'Expenses employees incurred for the business, repaid with salary'
  ) x
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id AND a.code = x.code);
