-- 011_retainer_paid.sql
-- A retainer has two independent halves, and the original table only had one
-- column for both.
--
--   amount_paid    how much cash the customer has actually sent for it. Until
--                  they pay, the retainer is a receivable like any invoice.
--   applied_amount how much of that advance has since been consumed by real
--                  invoices. That is what releases the unearned-revenue
--                  liability and turns the money into income.
--
-- Money can arrive and sit unearned for months, and work can be delivered
-- against an advance that has not landed yet. Tracking both in one column made
-- an unpaid retainer look spent, and left the receivable control account
-- disagreeing with the ageing report by exactly the unpaid balance.

ALTER TABLE retainer_invoices
  ADD COLUMN amount_paid DECIMAL(19,4) NOT NULL DEFAULT 0 AFTER amount;

-- Everything already marked paid or beyond was, by the old meaning, settled.
UPDATE retainer_invoices
   SET amount_paid = amount
 WHERE status IN ('paid', 'partially_applied', 'applied');
