-- Counting the cash.
--
-- A count records the notes and coins in a cash account on a date, against
-- what the books say should be there. A difference is posted to Cash Short &
-- Excess so the book balance agrees with the drawer; the count stays as the
-- record of who counted, what, and when.

CREATE TABLE IF NOT EXISTS cash_counts (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  bank_account_id     BIGINT        NOT NULL,
  counted_on          DATE          NOT NULL,
  -- {"500": 12, "200": 4, ...}: pieces of each denomination, in rupees.
  denominations       JSON          NOT NULL,
  counted             DECIMAL(19,4) NOT NULL,
  book                DECIMAL(19,4) NOT NULL,
  difference          DECIMAL(19,4) NOT NULL,
  note                VARCHAR(300)  NULL,
  journal_entry_id    BIGINT        NULL,
  created_by_user_id  BIGINT        NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_cc_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_cc_bank FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id),
  KEY idx_cc_account (bank_account_id, counted_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO accounts (org_id, code, name, type, subtype, description, is_system, is_active)
SELECT o.id, '6990', 'Cash Short & Excess', 'expense', NULL,
       'Differences found when cash is counted: a debit is a shortage, a credit an excess', 1, 1
  FROM organizations o
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id AND a.code = '6990');
