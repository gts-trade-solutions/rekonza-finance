-- The rest of payroll.
--
-- Advances and loans to employees, recovered from salary month by month, each
-- month's recovery kept loan by loan so a balance is always known. Arrears: a
-- salary revision dated back to months already paid owes the difference, and
-- which months it was paid for is kept so it is never paid twice. Investment
-- declarations and the proofs that follow them, which decide TDS under the old
-- regime. Reimbursement claims, with the bills attached, approved and then paid
-- with the month's salary.

CREATE TABLE IF NOT EXISTS employee_loans (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  employee_id         BIGINT        NOT NULL,
  kind                ENUM('advance','loan') NOT NULL DEFAULT 'advance',
  amount              DECIMAL(19,4) NOT NULL,
  -- Recovered each month until the balance is gone; the last is what is left.
  instalment          DECIMAL(19,4) NOT NULL,
  given_on            DATE          NOT NULL,
  -- The payroll month recovery starts with, YYYY-MM.
  first_month         CHAR(7)       NOT NULL,
  paid_from_bank_id   BIGINT        NULL,
  journal_entry_id    BIGINT        NULL,
  status              ENUM('active','cancelled') NOT NULL DEFAULT 'active',
  notes               VARCHAR(300)  NULL,
  created_by_user_id  BIGINT        NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_eloan_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_eloan_emp FOREIGN KEY (employee_id) REFERENCES employees(id),
  KEY idx_eloan_emp (org_id, employee_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payroll_recoveries (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  run_id       BIGINT        NOT NULL,
  loan_id      BIGINT        NOT NULL,
  employee_id  BIGINT        NOT NULL,
  amount       DECIMAL(19,4) NOT NULL,
  CONSTRAINT fk_prec_run FOREIGN KEY (run_id) REFERENCES payroll_runs(id) ON DELETE CASCADE,
  CONSTRAINT fk_prec_loan FOREIGN KEY (loan_id) REFERENCES employee_loans(id),
  UNIQUE KEY uq_prec (run_id, loan_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A line's arrears, its loan instalments and its approved claims, each apart
-- from what was typed in by hand, so a recompute can tell them apart.
ALTER TABLE payroll_lines
  ADD COLUMN arrears        DECIMAL(19,4) NOT NULL DEFAULT 0 AFTER bonus,
  ADD COLUMN claims         DECIMAL(19,4) NOT NULL DEFAULT 0 AFTER reimbursement,
  ADD COLUMN loan_recovery  DECIMAL(19,4) NOT NULL DEFAULT 0 AFTER advance_recovery;

CREATE TABLE IF NOT EXISTS payroll_arrears (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  run_id       BIGINT        NOT NULL,
  employee_id  BIGINT        NOT NULL,
  -- The month the difference belongs to.
  for_month    CHAR(7)       NOT NULL,
  amount       DECIMAL(19,4) NOT NULL,
  basic_da     DECIMAL(19,4) NOT NULL DEFAULT 0,
  CONSTRAINT fk_parr_run FOREIGN KEY (run_id) REFERENCES payroll_runs(id) ON DELETE CASCADE,
  KEY idx_parr_emp (employee_id, for_month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tax_declarations (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id               BIGINT        NOT NULL,
  employee_id          BIGINT        NOT NULL,
  -- The financial year by the year it starts: 2026 is April 2026 to March 2027.
  fy_start             SMALLINT      NOT NULL,
  section              ENUM('80C','80CCD1B','80D','80E','80G','80TTA','24B','HRA','other') NOT NULL,
  description          VARCHAR(200)  NULL,
  declared             DECIMAL(19,4) NOT NULL DEFAULT 0,
  -- What the proofs bear out, once they are in.
  proved               DECIMAL(19,4) NULL,
  status               ENUM('declared','submitted','accepted','rejected') NOT NULL DEFAULT 'declared',
  review_note          VARCHAR(300)  NULL,
  reviewed_by_user_id  BIGINT        NULL,
  created_at           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_tdecl_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_tdecl_emp FOREIGN KEY (employee_id) REFERENCES employees(id),
  KEY idx_tdecl_emp (org_id, employee_id, fy_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- HRA is half of basic and DA exempt in Delhi, Mumbai, Kolkata and Chennai; two-fifths elsewhere.
ALTER TABLE employees ADD COLUMN metro_city TINYINT(1) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS reimbursement_claims (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id               BIGINT        NOT NULL,
  employee_id          BIGINT        NOT NULL,
  claim_date           DATE          NOT NULL,
  category             VARCHAR(60)   NOT NULL,
  description          VARCHAR(300)  NULL,
  amount               DECIMAL(19,4) NOT NULL,
  status               ENUM('submitted','approved','rejected') NOT NULL DEFAULT 'submitted',
  review_note          VARCHAR(300)  NULL,
  reviewed_by_user_id  BIGINT        NULL,
  -- The payroll month that repays it.
  paid_in_run_id       BIGINT        NULL,
  created_by_user_id   BIGINT        NULL,
  created_at           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_rclaim_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_rclaim_emp FOREIGN KEY (employee_id) REFERENCES employees(id),
  CONSTRAINT fk_rclaim_run FOREIGN KEY (paid_in_run_id) REFERENCES payroll_runs(id) ON DELETE SET NULL,
  KEY idx_rclaim_emp (org_id, employee_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
