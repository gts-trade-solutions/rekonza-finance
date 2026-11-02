-- Projects and timesheets: work done for a customer, the hours logged to it,
-- and the invoice that bills them.
--
-- A project is billed one of four ways, as in Zoho Books: a fixed fee; by the
-- hour at one rate for the whole project; by the hour at each task's rate; or
-- by the hour at each person's rate. Time is logged against the project (and
-- a task, when there are tasks), and stays unbilled until an invoice takes it:
-- `invoice_id` on the entry is what stops an hour being billed twice. Voiding
-- that invoice releases the hours again (services/projects.ts).
--
-- A cost rate on each person lets a project show what it earned against what
-- the time cost, beside the expenses booked to it.

CREATE TABLE IF NOT EXISTS projects (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id          BIGINT        NOT NULL,
  customer_id     BIGINT        NOT NULL,
  name            VARCHAR(200)  NOT NULL,
  code            VARCHAR(40)   NULL,
  description     VARCHAR(1000) NULL,
  billing_method  ENUM('fixed','project_hours','task_hours','staff_hours') NOT NULL DEFAULT 'project_hours',
  -- Project hours: the rate an hour. Fixed: the fee.
  rate            DECIMAL(19,4) NOT NULL DEFAULT 0,
  fixed_amount    DECIMAL(19,4) NOT NULL DEFAULT 0,
  budget_hours    DECIMAL(10,2) NULL,
  budget_amount   DECIMAL(19,4) NULL,
  -- What its invoices are charged at: the SAC and the GST rate.
  sac_code        VARCHAR(10)   NULL,
  gst_rate_pct    DECIMAL(5,2)  NOT NULL DEFAULT 18,
  status          ENUM('active','completed','archived') NOT NULL DEFAULT 'active',
  start_date      DATE          NULL,
  end_date        DATE          NULL,
  created_by_user_id BIGINT     NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_projects_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_projects_customer FOREIGN KEY (customer_id) REFERENCES contacts(id),
  KEY idx_projects_org (org_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_tasks (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id      BIGINT        NOT NULL,
  project_id  BIGINT        NOT NULL,
  name        VARCHAR(200)  NOT NULL,
  rate        DECIMAL(19,4) NOT NULL DEFAULT 0,
  billable    TINYINT(1)    NOT NULL DEFAULT 1,
  is_active   TINYINT(1)    NOT NULL DEFAULT 1,
  CONSTRAINT fk_ptasks_project FOREIGN KEY (project_id) REFERENCES projects(id),
  KEY idx_ptasks_project (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_users (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id      BIGINT        NOT NULL,
  project_id  BIGINT        NOT NULL,
  user_id     BIGINT        NOT NULL,
  -- Staff hours: what the customer is charged for this person's hour.
  rate        DECIMAL(19,4) NOT NULL DEFAULT 0,
  -- What the hour costs the business, for the project's profit.
  cost_rate   DECIMAL(19,4) NOT NULL DEFAULT 0,
  CONSTRAINT fk_pusers_project FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT fk_pusers_user FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE KEY uq_pusers (project_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS time_entries (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id      BIGINT        NOT NULL,
  project_id  BIGINT        NOT NULL,
  task_id     BIGINT        NULL,
  user_id     BIGINT        NOT NULL,
  entry_date  DATE          NOT NULL,
  minutes     INT           NOT NULL,
  notes       VARCHAR(500)  NULL,
  billable    TINYINT(1)    NOT NULL DEFAULT 1,
  -- The invoice that billed it; null while unbilled.
  invoice_id  BIGINT        NULL,
  created_by_user_id BIGINT NULL,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_time_project FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT fk_time_task FOREIGN KEY (task_id) REFERENCES project_tasks(id),
  CONSTRAINT fk_time_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT ck_time_minutes CHECK (minutes > 0 AND minutes <= 1440),
  KEY idx_time_project (project_id, invoice_id),
  KEY idx_time_user (org_id, user_id, entry_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- An invoice raised for a project, and a cost booked to one.
ALTER TABLE invoices ADD COLUMN project_id BIGINT NULL;
ALTER TABLE expenses
  ADD COLUMN project_id BIGINT NULL,
  -- A billable expense, once it has been re-charged on an invoice.
  ADD COLUMN billed_invoice_id BIGINT NULL;
ALTER TABLE bills ADD COLUMN project_id BIGINT NULL;
