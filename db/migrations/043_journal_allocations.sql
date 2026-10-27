-- Bill-wise journals, bad debts, and the provision for doubtful ones.
--
-- A journal that credits a customer's account — a discount allowed after the
-- event, a set-off against what we owe them, a debt written off — settles
-- particular invoices, just as a receipt does. Recording which keeps the
-- invoice's balance and status, and the ageing, true; without it the journal
-- lowers what the customer owes but every invoice still shows unpaid. The
-- same for a debit to a supplier's account against their bills.
--
-- A debt written off is an expense of the year it is written off. One that
-- is only doubtful is provided for: an expense, against a provision that sits
-- beside the receivables and reduces them on the balance sheet.

CREATE TABLE IF NOT EXISTS journal_allocations (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id        BIGINT        NOT NULL,
  entry_id      BIGINT        NOT NULL,
  contact_id    BIGINT        NOT NULL,
  target_type   ENUM('invoice','bill','opening') NOT NULL,
  target_id     BIGINT        NOT NULL,
  amount        DECIMAL(19,4) NOT NULL,
  reversed      TINYINT(1)    NOT NULL DEFAULT 0,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ja_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_ja_entry FOREIGN KEY (entry_id) REFERENCES journal_entries(id),
  CONSTRAINT ck_ja_amount CHECK (amount > 0),
  KEY idx_ja_entry (entry_id),
  KEY idx_ja_target (org_id, target_type, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO accounts (org_id, code, name, type, subtype, description, is_system, is_active)
SELECT o.id, x.code, x.name, x.type, x.subtype, x.description, 1, 1
  FROM organizations o
  JOIN (
    SELECT '1190' AS code, 'Provision for Doubtful Debts' AS name, 'asset' AS type, 'receivable' AS subtype,
           'A credit balance against receivables: what is not expected to be collected' AS description
    UNION ALL SELECT '6955', 'Provision for Doubtful Debts (expense)', 'expense', NULL,
           'The charge, or release, as the provision is raised or lowered'
  ) x
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id AND a.code = x.code);
