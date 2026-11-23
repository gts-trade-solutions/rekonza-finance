-- Zoho Books' bank matching: one statement line matched to several documents
-- at once (two invoices paid by one transfer, a payment plus the bank's
-- charge), and categorising a line as a customer payment, an expense, a
-- transfer and the rest. Each thing a line is matched to is kept here, with
-- whether the match itself created it (a receipt recorded for an invoice, an
-- expense, a transfer, a difference entry), so that unmatching undoes exactly
-- what matching did and leaves alone what was already in the books.

CREATE TABLE IF NOT EXISTS bank_transaction_links (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  bank_transaction_id BIGINT        NOT NULL,
  -- payment, expense, transfer, journal_entry
  target_type         VARCHAR(30)   NOT NULL,
  target_id           BIGINT        NOT NULL,
  amount              DECIMAL(19,4) NOT NULL DEFAULT 0,
  -- 1: the match or categorisation made it, and unmatching takes it back.
  created_by_match    TINYINT(1)    NOT NULL DEFAULT 0,
  -- Zoho's category, when the line was categorised by hand (customer_payment, expense, …).
  category            VARCHAR(40)   NULL,
  -- A refund of an advance: how much of that payment's unused amount it took.
  refunded_payment_id BIGINT        NULL,
  created_by_user_id  BIGINT        NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_btl_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_btl_txn FOREIGN KEY (bank_transaction_id) REFERENCES bank_transactions(id) ON DELETE CASCADE,
  KEY idx_btl_txn (bank_transaction_id),
  KEY idx_btl_target (org_id, target_type, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
