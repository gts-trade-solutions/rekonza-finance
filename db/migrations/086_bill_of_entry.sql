-- Bills of entry: goods imported.
--
-- An overseas supplier charges no GST. The tax on imported goods is IGST (and
-- cess) paid at customs against the bill of entry, with the basic customs duty
-- and the social welfare surcharge beside it. The IGST is input credit, claimed
-- in GSTR-3B table 4(A)(1) "Import of goods" — never through a bill, which is
-- why an import needed a record of its own. The duty is a cost of the goods.
--
--   Dr Input IGST (and cess)    the tax paid at customs, when the credit is claimable
--   Dr Purchases / Inventory    the customs duty (and the IGST when it is not)
--     Cr Bank                   what was paid through ICEGATE or the agent
--
-- One bill of entry per number, date and port: the portal matches on all three.

CREATE TABLE IF NOT EXISTS bills_of_entry (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  branch_id         BIGINT        NOT NULL,
  vendor_id         BIGINT        NULL,
  bill_id           BIGINT        NULL,
  boe_no            VARCHAR(20)   NOT NULL,
  boe_date          DATE          NOT NULL,
  port_code         VARCHAR(6)    NOT NULL,
  assessable_value  DECIMAL(19,4) NOT NULL DEFAULT 0,
  customs_duty      DECIMAL(19,4) NOT NULL DEFAULT 0,
  igst              DECIMAL(19,4) NOT NULL DEFAULT 0,
  cess              DECIMAL(19,4) NOT NULL DEFAULT 0,
  itc_eligibility   ENUM('eligible','ineligible','capital_goods') NOT NULL DEFAULT 'eligible',
  duty_account_id   BIGINT        NOT NULL,
  paid_through_bank_account_id BIGINT NOT NULL,
  journal_entry_id  BIGINT        NULL,
  status            ENUM('recorded','void') NOT NULL DEFAULT 'recorded',
  void_reason       VARCHAR(255)  NULL,
  notes             VARCHAR(500)  NULL,
  created_by_user_id BIGINT       NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_boe_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_boe_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_boe_vendor FOREIGN KEY (vendor_id) REFERENCES contacts(id),
  CONSTRAINT fk_boe_bill FOREIGN KEY (bill_id) REFERENCES bills(id),
  CONSTRAINT fk_boe_duty FOREIGN KEY (duty_account_id) REFERENCES accounts(id),
  CONSTRAINT fk_boe_bank FOREIGN KEY (paid_through_bank_account_id) REFERENCES bank_accounts(id),
  UNIQUE KEY uq_boe (org_id, boe_no, boe_date, port_code),
  KEY idx_boe_date (org_id, boe_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
