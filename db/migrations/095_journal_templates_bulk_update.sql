-- Zoho Books' Accountant tools: journal templates, and bulk reclassification.
--
-- A journal template is a manual journal kept to be used again — the monthly
-- rent accrual, the salary provision — with or without its amounts. Using one
-- fills the journal form; nothing posts until the user saves the entry.
CREATE TABLE IF NOT EXISTS journal_templates (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  name                VARCHAR(150)  NOT NULL,
  memo                VARCHAR(500)  NULL,
  -- [{ accountId, debitPaise, creditPaise, description, contactId, costCentreId }]
  template_lines      JSON          NOT NULL,
  -- Whether the amounts are part of the template, or only the accounts.
  with_amounts        TINYINT(1)    NOT NULL DEFAULT 1,
  created_by_user_id  BIGINT        NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_jtpl_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_jtpl_name (org_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bulk update: lines moved from one account to another in one go. Posted
-- documents are not rewritten — their entries stay as they were — and one
-- reclassification journal moves the amounts, line by line, so the trail
-- shows what moved, from where, and who moved it. This keeps which lines a
-- reclassification has already moved, so the same line is never moved twice
-- (unless that reclassification is reversed, which frees its lines again).
CREATE TABLE IF NOT EXISTS reclassified_lines (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  journal_line_id     BIGINT        NOT NULL,
  reclass_entry_id    BIGINT        NOT NULL,
  from_account_id     BIGINT        NOT NULL,
  to_account_id       BIGINT        NOT NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_recl_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  KEY idx_recl_line (journal_line_id),
  KEY idx_recl_entry (org_id, reclass_entry_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
