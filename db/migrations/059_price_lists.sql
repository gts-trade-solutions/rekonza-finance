-- Price lists: what a customer is charged, when it is not the item's own price.
--
-- A list is either a percentage on (or off) every item's price — dealers at
-- 10% off — or a rate for each item it names, with items it does not name at
-- their own price. A customer on a list is charged from it.

CREATE TABLE IF NOT EXISTS price_lists (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id       BIGINT        NOT NULL,
  name         VARCHAR(100)  NOT NULL,
  basis        ENUM('percent','per_item') NOT NULL DEFAULT 'percent',
  -- For 'percent': +5 is 5% above the item's price, -10 is 10% below.
  percent      DECIMAL(6,2)  NOT NULL DEFAULT 0,
  is_active    TINYINT(1)    NOT NULL DEFAULT 1,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pl_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_pl_name (org_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS price_list_items (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  price_list_id  BIGINT        NOT NULL,
  item_id        BIGINT        NOT NULL,
  rate           DECIMAL(19,4) NOT NULL,
  CONSTRAINT fk_pli_list FOREIGN KEY (price_list_id) REFERENCES price_lists(id) ON DELETE CASCADE,
  CONSTRAINT fk_pli_item FOREIGN KEY (item_id) REFERENCES items(id),
  UNIQUE KEY uq_pli (price_list_id, item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE contacts
  ADD COLUMN price_list_id BIGINT NULL,
  ADD CONSTRAINT fk_contacts_price_list FOREIGN KEY (price_list_id) REFERENCES price_lists(id);
