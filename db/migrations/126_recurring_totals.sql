-- Zoho Books' New Recurring Invoice, the parts recorded on 2026-11-24:
--   * "Entity type": Invoice / Bill Of Supply — a bill-of-supply profile raises
--     bills of supply (exempt, nil-rated or non-GST goods, or a composition
--     dealer's sale);
--   * the totals' Shipping Charges and the adjustment row (its own label, an
--     amount that may be negative), carried onto every invoice it raises;
--   * Round Off "(No Rounding)" and its "Rounding Off Preference" window: No
--     Rounding, or round the total to the nearest whole number.
-- Profiles saved before this keep rounding to the rupee, as their invoices
-- always have; a new profile starts on Zoho's "No Rounding".
ALTER TABLE recurring_invoices
  ADD COLUMN entity_type       ENUM('invoice','bill_of_supply') NOT NULL DEFAULT 'invoice' AFTER profile_name,
  ADD COLUMN shipping_charge   DECIMAL(18,4) NOT NULL DEFAULT 0 AFTER terms,
  ADD COLUMN adjustment        DECIMAL(18,4) NOT NULL DEFAULT 0 AFTER shipping_charge,
  ADD COLUMN adjustment_label  VARCHAR(60)   NULL AFTER adjustment,
  ADD COLUMN round_off         ENUM('none','whole') NOT NULL DEFAULT 'whole' AFTER adjustment_label;
