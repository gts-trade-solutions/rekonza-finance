-- Invoice templates, reporting tags, kits and item groups, the customer and
-- vendor portal, and saved views.

-- Invoice template: the layout (classic, modern, compact), an accent colour,
-- and what else to print. Rule 46 decides the content; this decides the look.
ALTER TABLE organizations ADD COLUMN print_template JSON NULL;

-- Reporting tags: dimensions of the business beyond the chart of accounts and
-- cost centres — region, channel, salesperson's team — each with its values.
-- A document carries at most one value of each tag, and reports can be cut by
-- any tag (services/reporting-tags.ts).
CREATE TABLE IF NOT EXISTS reporting_tags (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id     BIGINT        NOT NULL,
  name       VARCHAR(80)   NOT NULL,
  is_active  TINYINT(1)    NOT NULL DEFAULT 1,
  created_at TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rtag (org_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reporting_tag_options (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id     BIGINT        NOT NULL,
  tag_id     BIGINT        NOT NULL,
  value      VARCHAR(80)   NOT NULL,
  is_active  TINYINT(1)    NOT NULL DEFAULT 1,
  CONSTRAINT fk_rtopt_tag FOREIGN KEY (tag_id) REFERENCES reporting_tags(id),
  UNIQUE KEY uq_rtopt (tag_id, value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reporting_tag_links (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id     BIGINT        NOT NULL,
  tag_id     BIGINT        NOT NULL,
  option_id  BIGINT        NOT NULL,
  -- invoice, bill, expense or journal_entry (a manual journal).
  entity     VARCHAR(30)   NOT NULL,
  entity_id  BIGINT        NOT NULL,
  CONSTRAINT fk_rtlink_option FOREIGN KEY (option_id) REFERENCES reporting_tag_options(id),
  UNIQUE KEY uq_rtlink (tag_id, entity, entity_id),
  KEY idx_rtlink_entity (org_id, entity, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Kits: an item sold as a set — a service kit of four brake pads and a bottle
-- of fluid. The kit itself holds no stock; selling one takes each component
-- out of stock, and returning one puts them back.
ALTER TABLE items
  ADD COLUMN is_kit TINYINT(1) NOT NULL DEFAULT 0,
  -- Item groups: variants of one product (sizes, colours), each its own item.
  ADD COLUMN item_group_id BIGINT NULL,
  ADD COLUMN variant JSON NULL;

CREATE TABLE IF NOT EXISTS item_components (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id             BIGINT        NOT NULL,
  kit_item_id        BIGINT        NOT NULL,
  component_item_id  BIGINT        NOT NULL,
  qty                DECIMAL(15,3) NOT NULL,
  CONSTRAINT fk_icomp_kit FOREIGN KEY (kit_item_id) REFERENCES items(id),
  CONSTRAINT fk_icomp_component FOREIGN KEY (component_item_id) REFERENCES items(id),
  CONSTRAINT ck_icomp_qty CHECK (qty > 0),
  UNIQUE KEY uq_icomp (kit_item_id, component_item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS item_groups (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id      BIGINT        NOT NULL,
  name        VARCHAR(200)  NOT NULL,
  -- [{"name": "Size", "values": ["S", "M", "L"]}, …]
  attributes  JSON          NOT NULL,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_igroup (org_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Portal access: a link a customer or vendor signs in with, no password, to
-- see their own account — invoices, quotes to accept, statements, payments;
-- for a vendor, orders, bills and payments, and a place to send their bill.
-- Only the token's hash is kept; the link lapses and can be withdrawn.
CREATE TABLE IF NOT EXISTS portal_access (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id          BIGINT        NOT NULL,
  contact_id      BIGINT        NOT NULL,
  side            ENUM('customer','vendor') NOT NULL,
  token_hash      CHAR(64)      NOT NULL,
  email           VARCHAR(190)  NULL,
  expires_at      TIMESTAMP     NOT NULL,
  revoked_at      TIMESTAMP     NULL,
  last_opened_at  TIMESTAMP     NULL,
  opens           INT           NOT NULL DEFAULT 0,
  created_by_user_id BIGINT     NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_portal_contact FOREIGN KEY (contact_id) REFERENCES contacts(id),
  UNIQUE KEY uq_portal_token (token_hash),
  KEY idx_portal_contact (org_id, contact_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Saved views: a list's filters kept under a name, for one person or shared.
CREATE TABLE IF NOT EXISTS saved_views (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id      BIGINT        NOT NULL,
  user_id     BIGINT        NOT NULL,
  list        VARCHAR(40)   NOT NULL,
  name        VARCHAR(80)   NOT NULL,
  filters     JSON          NOT NULL,
  is_shared   TINYINT(1)    NOT NULL DEFAULT 0,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_views (org_id, list)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
