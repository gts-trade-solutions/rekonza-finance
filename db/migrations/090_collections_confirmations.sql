-- Collections, balance confirmations, and issuing stock for use.
--
-- Collections: the follow-up on what customers owe — the call made, what they
-- said, the date they promised to pay and how much, and when to chase next.
-- Kept per customer, optionally against one invoice. A promise whose date
-- passes with the money still owed shows as broken (services/collections.ts).
--
-- Balance confirmations: the auditor's circularisation. A customer or vendor
-- is asked to confirm the balance on a date; their figure is recorded beside
-- ours, with the difference and whether it is agreed or disputed. Our figure
-- is the ledger's (reports/party-statement.ts), fixed when the request is made.
--
-- Stock issued for use: goods taken out of stock to be consumed — in the
-- office, for repairs, for a job — rather than sold. It is an adjustment with
-- its own reason, so the stock ledger names it for what it is.

ALTER TABLE stock_adjustments
  MODIFY COLUMN reason ENUM('stocktake','damage','theft','expiry','sample','opening','other','issued') NOT NULL DEFAULT 'stocktake';

CREATE TABLE IF NOT EXISTS collection_followups (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id          BIGINT        NOT NULL,
  contact_id      BIGINT        NOT NULL,
  invoice_id      BIGINT        NULL,
  kind            ENUM('call','email','whatsapp','visit','note') NOT NULL DEFAULT 'call',
  note            VARCHAR(1000) NOT NULL,
  promised_date   DATE          NULL,
  promised_amount DECIMAL(19,4) NULL,
  next_followup   DATE          NULL,
  user_id         BIGINT        NULL,
  author_name     VARCHAR(150)  NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_follow_contact FOREIGN KEY (contact_id) REFERENCES contacts(id),
  KEY idx_follow_contact (org_id, contact_id, id),
  KEY idx_follow_next (org_id, next_followup)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS balance_confirmations (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id          BIGINT        NOT NULL,
  contact_id      BIGINT        NOT NULL,
  side            ENUM('customer','vendor') NOT NULL,
  as_of           DATE          NOT NULL,
  our_balance     DECIMAL(19,4) NOT NULL,
  their_balance   DECIMAL(19,4) NULL,
  status          ENUM('requested','agreed','disputed') NOT NULL DEFAULT 'requested',
  notes           VARCHAR(1000) NULL,
  requested_by_user_id BIGINT   NULL,
  responded_at    TIMESTAMP     NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_confirm_contact FOREIGN KEY (contact_id) REFERENCES contacts(id),
  KEY idx_confirm_org (org_id, as_of),
  KEY idx_confirm_contact (org_id, contact_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
