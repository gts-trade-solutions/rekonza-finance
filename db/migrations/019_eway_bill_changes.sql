-- 019_eway_bill_changes.sql
-- An e-way bill after it is generated: the vehicle changes, the validity is
-- extended, or the bill is cancelled.
--
-- The bill row keeps its current state. Every change is also written to
-- eway_bill_events, because a checkpost asks which lorry carried the goods on
-- which day, and the current row only knows the last one.

ALTER TABLE eway_bills
  ADD COLUMN cancelled_at  DATETIME     NULL AFTER valid_until,
  ADD COLUMN cancel_reason VARCHAR(200) NULL AFTER cancelled_at;

CREATE TABLE IF NOT EXISTS eway_bill_events (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id             BIGINT        NOT NULL,
  eway_bill_id       BIGINT        NOT NULL,
  -- The number at the time. A bill cancelled and generated again keeps its row
  -- and gets a new number, and the history has to show both.
  eway_bill_no       VARCHAR(20)   NOT NULL,
  kind               ENUM('generated','vehicle_changed','extended','cancelled') NOT NULL,
  vehicle_no         VARCHAR(20)   NULL,
  transport_mode     ENUM('road','rail','air','ship') NULL,
  -- Where the goods were when the vehicle changed or the extension was asked.
  from_place         VARCHAR(100)  NULL,
  reason_code        VARCHAR(4)    NULL,
  remark             VARCHAR(200)  NULL,
  valid_until        DATETIME      NULL,
  created_by_user_id BIGINT        NULL,
  created_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ewbe_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_ewbe_bill FOREIGN KEY (eway_bill_id) REFERENCES eway_bills(id) ON DELETE CASCADE,
  KEY idx_ewbe_bill (eway_bill_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
