-- Zoho Books' "PDF Template : 'Standard' Change" on an invoice: the template
-- this one invoice prints in, when it is not the one chosen for invoices in
-- Settings → PDF Templates. NULL follows the setting.

ALTER TABLE invoices
  ADD COLUMN print_template VARCHAR(40) COLLATE utf8mb4_unicode_ci NULL AFTER payment_terms;
