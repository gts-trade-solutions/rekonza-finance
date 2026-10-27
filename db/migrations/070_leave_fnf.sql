-- Leave, and settling up with someone who leaves.
--
-- Leave is a ledger per employee and kind: what was given (opening, monthly or
-- yearly accrual, adjustment) less what was taken, encashed or lapsed. The
-- payroll month accrues it, and unpaid leave becomes that month's unpaid days.
--
-- The full and final settlement is worked out from the last day: gratuity
-- under the Payment of Gratuity Act, leave encashed, notice paid or
-- recovered, other recoveries and the tax on it, posted as one entry.

CREATE TABLE IF NOT EXISTS leave_types (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT       NOT NULL,
  code                VARCHAR(10)  NOT NULL,
  name                VARCHAR(60)  NOT NULL,
  paid                TINYINT(1)   NOT NULL DEFAULT 1,
  annual_days         DECIMAL(5,1) NOT NULL DEFAULT 0,
  accrual             ENUM('monthly','yearly') NOT NULL DEFAULT 'monthly',
  carry_forward_max   DECIMAL(5,1) NULL,
  encashable          TINYINT(1)   NOT NULL DEFAULT 0,
  is_active           TINYINT(1)   NOT NULL DEFAULT 1,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_lvt_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_lvt_code (org_id, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS leave_entries (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT       NOT NULL,
  employee_id         BIGINT       NOT NULL,
  leave_type_id       BIGINT       NOT NULL,
  kind                ENUM('opening','accrual','adjustment','taken','encashed','lapsed') NOT NULL,
  days                DECIMAL(6,1) NOT NULL,
  from_date           DATE         NULL,
  to_date             DATE         NULL,
  period              VARCHAR(7)   NULL,
  note                VARCHAR(300) NULL,
  status              ENUM('approved','cancelled') NOT NULL DEFAULT 'approved',
  created_by_user_id  BIGINT       NULL,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_lve_emp FOREIGN KEY (employee_id) REFERENCES employees(id),
  CONSTRAINT fk_lve_type FOREIGN KEY (leave_type_id) REFERENCES leave_types(id),
  -- One accrual or lapse per employee, kind of leave and month.
  UNIQUE KEY uq_lve_period (employee_id, leave_type_id, kind, period),
  KEY idx_lve_emp (org_id, employee_id, from_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fnf_settlements (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  employee_id         BIGINT        NOT NULL,
  last_day            DATE          NOT NULL,
  components          JSON          NOT NULL,
  net_amount          DECIMAL(18,2) NOT NULL,
  status              ENUM('posted','paid','reversed') NOT NULL DEFAULT 'posted',
  journal_entry_id    BIGINT        NULL,
  payment_entry_id    BIGINT        NULL,
  created_by_user_id  BIGINT        NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_on             DATE          NULL,
  CONSTRAINT fk_fnf_emp FOREIGN KEY (employee_id) REFERENCES employees(id),
  KEY idx_fnf_org (org_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO accounts (org_id, code, name, type, subtype, description, is_system, is_active)
SELECT o.id, '6230', 'Gratuity', 'expense', NULL,
       'Gratuity paid or provided under the Payment of Gratuity Act, 1972', 1, 1
  FROM organizations o
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id AND a.code = '6230');
