-- Cheque returns.
--
-- Until now a bounce was a status and nothing else: the receipt the cheque
-- paid stayed in the books, the invoice stayed marked paid, and the bank's
-- return charge had nowhere to go. A return now reverses the linked payment on
-- the day the bank returned it, posts the charge, and keeps the bank's reason,
-- which is what a notice under section 138 of the Negotiable Instruments Act
-- has to quote.

ALTER TABLE cheques
  ADD COLUMN cleared_on        DATE          NULL AFTER status,
  ADD COLUMN returned_on       DATE          NULL AFTER cleared_on,
  ADD COLUMN return_reason     VARCHAR(200)  NULL AFTER returned_on,
  ADD COLUMN return_charges    DECIMAL(19,4) NOT NULL DEFAULT 0 AFTER return_reason,
  ADD COLUMN charges_to_party  TINYINT(1)    NOT NULL DEFAULT 0 AFTER return_charges,
  ADD COLUMN charges_entry_id  BIGINT        NULL AFTER charges_to_party,
  ADD CONSTRAINT fk_chq_charges_entry FOREIGN KEY (charges_entry_id) REFERENCES journal_entries(id);
