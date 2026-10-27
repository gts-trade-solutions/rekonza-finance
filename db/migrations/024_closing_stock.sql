-- 024_closing_stock.sql
-- Stock enters the statements as Tally puts it there: worked out from the
-- documents, valued at weighted average cost, and shown as closing stock
-- (lib/server/reports/stock.ts). Stock adjustments therefore stop posting —
-- a write-off reaches the profit and loss as a smaller closing stock.
--
-- Opening stock needs a value as well as a quantity. The rate is what the stock
-- was carried at when the books began; left empty, the item's purchase price
-- stands in for it.

ALTER TABLE items
  ADD COLUMN opening_stock_rate DECIMAL(19,4) NULL AFTER opening_stock_qty;
