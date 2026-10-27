-- What the books need to know about a supplier that is an MSME, and where to
-- pay a party.
--
-- The 45-day rule is not one rule. The MSMED Act (section 15) protects micro
-- and small enterprises only — not medium ones, and not traders registered on
-- Udyam only for priority-sector lending — and the deadline is the period
-- agreed in writing, at most 45 days, or 15 days when nothing was agreed in
-- writing. Section 43B(h) of the 1961 Act (37(2)(g) of the 2025 Act) then
-- disallows the expense until it is paid. So the category, the activity and
-- the written term are kept, and the deadline follows from them.
--
-- A party's bank account is what a payment file to the bank needs.

ALTER TABLE contacts
  ADD COLUMN msme_category ENUM('micro','small','medium') NULL AFTER msme_udyam_no,
  ADD COLUMN msme_activity ENUM('manufacturing','services','trading') NULL AFTER msme_category,
  -- The credit period agreed in writing, at most 45 days; NULL when there is
  -- no written agreement, which makes the limit 15 days.
  ADD COLUMN msme_agreement_days SMALLINT NULL AFTER msme_activity,
  ADD COLUMN bank_account_name VARCHAR(150) NULL AFTER shipping_address,
  ADD COLUMN bank_account_no VARCHAR(34) NULL AFTER bank_account_name,
  ADD COLUMN bank_ifsc CHAR(11) NULL AFTER bank_account_no,
  ADD COLUMN bank_name VARCHAR(120) NULL AFTER bank_ifsc,
  ADD CONSTRAINT ck_contact_msme_days CHECK (msme_agreement_days IS NULL OR (msme_agreement_days BETWEEN 1 AND 45));
