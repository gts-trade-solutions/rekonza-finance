-- Cost centres: income and expense told apart by department, project, vehicle
-- or site, as Tally does. A journal line can name one; an invoice, bill or
-- expense names one for the whole document and it falls on that document's
-- income and expense lines. Balance-sheet lines carry none.

CREATE TABLE IF NOT EXISTS cost_centres (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id      BIGINT       NOT NULL,
  code        VARCHAR(20)  NOT NULL,
  name        VARCHAR(100) NOT NULL,
  category    VARCHAR(60)  NULL,
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ccen_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_cc_code (org_id, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE journal_lines
  ADD COLUMN cost_centre_id BIGINT NULL,
  ADD KEY idx_jl_cc (org_id, cost_centre_id, entry_date);

ALTER TABLE invoices ADD COLUMN cost_centre_id BIGINT NULL;
ALTER TABLE bills    ADD COLUMN cost_centre_id BIGINT NULL;
ALTER TABLE expenses ADD COLUMN cost_centre_id BIGINT NULL;
