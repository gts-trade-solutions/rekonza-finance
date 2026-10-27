-- Three small pieces of the masters.
--
-- Bill-wise on or off for a party, as Tally has it. Off, a payment is not
-- matched to bills by hand: it settles the party's oldest open documents first,
-- and their account is followed as a running balance.
--
-- Discount rules on a price list: from a quantity up, a percentage off, for
-- one item or for every item on the list.
--
-- A voucher type's own print format: a heading under the statutory title
-- (Tax Invoice stays; "Export invoice" goes under it), terms of its own, and
-- whether the UPI code and the bank details are printed.

ALTER TABLE contacts ADD COLUMN bill_wise TINYINT(1) NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS price_list_discounts (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  price_list_id  BIGINT        NOT NULL,
  -- Null: every item.
  item_id        BIGINT        NULL,
  min_qty        DECIMAL(19,6) NOT NULL DEFAULT 0,
  discount_pct   DECIMAL(6,3)  NOT NULL,
  CONSTRAINT fk_pldisc_list FOREIGN KEY (price_list_id) REFERENCES price_lists(id) ON DELETE CASCADE,
  CONSTRAINT fk_pldisc_item FOREIGN KEY (item_id) REFERENCES items(id),
  KEY idx_pldisc_list (price_list_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE voucher_types
  ADD COLUMN print_heading   VARCHAR(60)   NULL,
  ADD COLUMN print_terms     VARCHAR(2000) NULL,
  ADD COLUMN print_show_upi  TINYINT(1)    NOT NULL DEFAULT 1,
  ADD COLUMN print_show_bank TINYINT(1)    NOT NULL DEFAULT 1;
