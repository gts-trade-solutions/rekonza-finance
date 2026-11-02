-- Landed cost, as Zoho Books has it: freight, duty, clearing or insurance on
-- one bill spread over the goods of another (or the same) bill, into their
-- stock value (lib/server/services/landed-cost.ts). A charge line is a bill
-- line with no item; each allocation takes some or all of it, split over the
-- goods lines by quantity, by value or by hand.
CREATE TABLE IF NOT EXISTS landed_costs (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  charge_bill_id      BIGINT        NOT NULL,
  charge_line_id      BIGINT        NOT NULL,
  goods_bill_id       BIGINT        NOT NULL,
  method              ENUM('quantity','value','manual') NOT NULL,
  amount              DECIMAL(18,4) NOT NULL,
  -- The charge bill's date: when the cost was incurred, and from when it is in the stock value.
  allocated_on        DATE          NOT NULL,
  -- Perpetual books only: Dr Inventory, Cr the charge's account.
  journal_entry_id    BIGINT        NULL,
  created_by_user_id  BIGINT        NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_lc_goods (org_id, goods_bill_id),
  KEY idx_lc_charge (org_id, charge_line_id),
  CONSTRAINT fk_lc_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_lc_charge_bill FOREIGN KEY (charge_bill_id) REFERENCES bills(id),
  CONSTRAINT fk_lc_goods_bill FOREIGN KEY (goods_bill_id) REFERENCES bills(id)
);

CREATE TABLE IF NOT EXISTS landed_cost_lines (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id          BIGINT        NOT NULL,
  landed_cost_id  BIGINT        NOT NULL,
  bill_line_id    BIGINT        NOT NULL,
  amount          DECIMAL(18,4) NOT NULL,
  KEY idx_lcl_line (bill_line_id),
  KEY idx_lcl_lc (landed_cost_id),
  CONSTRAINT fk_lcl_lc FOREIGN KEY (landed_cost_id) REFERENCES landed_costs(id) ON DELETE CASCADE
);
