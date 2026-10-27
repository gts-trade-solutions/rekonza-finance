-- A second language on printed invoices (lib/print-languages.ts): hi, mr, gu,
-- ta, te, kn, ml or bn. Null prints English only. It can also be chosen at
-- print time, for a customer who reads another language.

ALTER TABLE organizations ADD COLUMN print_language VARCHAR(5) NULL;
