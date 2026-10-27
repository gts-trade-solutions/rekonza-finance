-- Foreign currency.
--
-- The books stay in rupees. A document in another currency keeps that
-- currency, the rate it was booked at, and its foreign amounts beside the
-- rupee ones; receivables and payables are carried at the booked rate.
-- Settling one at a different rate gives a realised exchange difference, and
-- open balances are restated at the closing rate at a period end (AS 11),
-- reversed the next day.

CREATE TABLE IF NOT EXISTS exchange_rates (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id      BIGINT        NOT NULL,
  currency    CHAR(3)       NOT NULL,
  rate_date   DATE          NOT NULL,
  -- Rupees for one unit of the currency.
  rate        DECIMAL(18,6) NOT NULL,
  source      VARCHAR(60)   NULL,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_fx_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_fx (org_id, currency, rate_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE contacts
  ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'INR';

ALTER TABLE invoices
  ADD COLUMN currency       CHAR(3)       NOT NULL DEFAULT 'INR',
  ADD COLUMN exchange_rate  DECIMAL(18,6) NOT NULL DEFAULT 1,
  ADD COLUMN fc_subtotal    DECIMAL(19,4) NULL,
  ADD COLUMN fc_total       DECIMAL(19,4) NULL,
  ADD COLUMN fc_amount_paid DECIMAL(19,4) NOT NULL DEFAULT 0;

ALTER TABLE bills
  ADD COLUMN currency       CHAR(3)       NOT NULL DEFAULT 'INR',
  ADD COLUMN exchange_rate  DECIMAL(18,6) NOT NULL DEFAULT 1,
  ADD COLUMN fc_subtotal    DECIMAL(19,4) NULL,
  ADD COLUMN fc_total       DECIMAL(19,4) NULL,
  ADD COLUMN fc_amount_paid DECIMAL(19,4) NOT NULL DEFAULT 0;

ALTER TABLE payments
  ADD COLUMN currency       CHAR(3)       NOT NULL DEFAULT 'INR',
  ADD COLUMN exchange_rate  DECIMAL(18,6) NOT NULL DEFAULT 1,
  ADD COLUMN fc_amount      DECIMAL(19,4) NULL,
  -- Rupees received or paid, less the rupee value of what was settled: a gain when positive on a receipt.
  ADD COLUMN fx_difference  DECIMAL(19,4) NOT NULL DEFAULT 0;

ALTER TABLE payment_allocations
  ADD COLUMN fc_amount DECIMAL(19,4) NULL;

INSERT INTO accounts (org_id, code, name, type, subtype, description, is_system, is_active)
SELECT o.id, x.code, x.name, x.type, NULL, x.description, 1, 1
  FROM organizations o
  JOIN (
    SELECT '4960' AS code, 'Foreign Exchange Gain' AS name, 'income' AS type,
           'Gains on settling or restating foreign-currency balances' AS description
    UNION ALL SELECT '6985', 'Foreign Exchange Loss', 'expense', 'Losses on settling or restating foreign-currency balances'
  ) x
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id AND a.code = x.code);
