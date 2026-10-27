-- Custom roles: a book's own mix of what each part of the app allows —
-- a billing clerk who raises invoices and sees the sales reports, a
-- storekeeper who sees stock and nothing that costs it.
--
-- Each is built on one of the standard roles (base_role), which still decides
-- the questions a role name answers: who may approve under an approval rule,
-- who sees cost prices. permissions holds the grants: {"sales": ["view",
-- "create"], "reports.sales": ["view"]}. Admins are never given a custom role.

CREATE TABLE IF NOT EXISTS custom_roles (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id       BIGINT       NOT NULL,
  name         VARCHAR(60)  NOT NULL,
  base_role    ENUM('accountant','sales','staff','viewer') NOT NULL,
  permissions  JSON         NOT NULL,
  description  VARCHAR(255) NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_crole_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_crole_name (org_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE users
  ADD COLUMN custom_role_id BIGINT NULL,
  ADD CONSTRAINT fk_users_crole FOREIGN KEY (custom_role_id) REFERENCES custom_roles(id);
