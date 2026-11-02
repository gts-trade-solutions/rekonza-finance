-- Time tracking as Zoho Books does it: a timer, and timesheet approval.
--
-- A timer runs for one person at a time; stopping it logs the time to the
-- project (and task) it was started on.
CREATE TABLE IF NOT EXISTS time_timers (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id      BIGINT        NOT NULL,
  user_id     BIGINT        NOT NULL,
  project_id  BIGINT        NOT NULL,
  task_id     BIGINT        NULL,
  notes       VARCHAR(500)  NULL,
  billable    TINYINT(1)    NOT NULL DEFAULT 1,
  started_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_timer_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_timer_project FOREIGN KEY (project_id) REFERENCES projects(id),
  UNIQUE KEY uq_timer_user (org_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- With timesheet approval on (Controls), time is logged as pending and someone
-- other than the person who logged it approves it before it can be billed.
-- NULL is time logged while approval was off: it bills as it always did.
ALTER TABLE time_entries
  ADD COLUMN approval_status     ENUM('pending','approved','rejected') NULL,
  ADD COLUMN approved_by_user_id BIGINT       NULL,
  ADD COLUMN approved_at         TIMESTAMP    NULL,
  ADD COLUMN approval_note       VARCHAR(300) NULL;
