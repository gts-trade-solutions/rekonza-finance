-- Interest charged to customers on invoices paid late.
--
-- Each charge covers an invoice's overdue balance up to a date; the next one
-- starts the day after, so no day is charged twice. The interest itself is
-- billed on an ordinary invoice: interest for delayed payment is part of the
-- value of the supply (CGST Act s.15(2)(d)) and taxed at its rate.

CREATE TABLE IF NOT EXISTS invoice_interest_charges (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  invoice_id          BIGINT        NOT NULL,
  charge_invoice_id   BIGINT        NOT NULL,
  from_date           DATE          NOT NULL,
  to_date             DATE          NOT NULL,
  balance             DECIMAL(19,4) NOT NULL,
  rate_pct            DECIMAL(5,2)  NOT NULL,
  interest            DECIMAL(19,4) NOT NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_iic_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_iic_inv FOREIGN KEY (invoice_id) REFERENCES invoices(id),
  CONSTRAINT fk_iic_charge FOREIGN KEY (charge_invoice_id) REFERENCES invoices(id),
  KEY idx_iic_invoice (invoice_id, to_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
