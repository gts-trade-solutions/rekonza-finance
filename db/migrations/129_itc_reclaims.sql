-- Rule 37 reclaims, one row each time credit reversed under Rule 37 is taken
-- again as the suppliers are paid (lib/server/gst/itc-reversals.ts), with the
-- share of each bill's reversal it took back.
--
-- Until now a reclaim only added to the reversal's reclaimed_* columns, so it
-- could not be told apart afterwards: which month took back how much on which
-- bill was lost. Keeping it lets a reclaim be undone (its entry reversed, the
-- amounts taken off again) and a Rule 37 reversal be undone once nothing has
-- been reclaimed against it — the Delete the client asked for on 2026-11-25,
-- "wherever we need edit and delete". A reclaim made before this has no row,
-- so the reversal it touched stays as it is.
CREATE TABLE IF NOT EXISTS itc_reclaims (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  -- The month of the return the credit is taken back in (YYYY-MM).
  period              VARCHAR(7)    NOT NULL,
  journal_entry_id    BIGINT        NULL,
  created_by_user_id  BIGINT        NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_itcrc_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  KEY idx_itcrc_org (org_id, period)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS itc_reclaim_lines (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  reclaim_id   BIGINT        NOT NULL,
  reversal_id  BIGINT        NOT NULL,
  cgst         DECIMAL(19,4) NOT NULL DEFAULT 0,
  sgst         DECIMAL(19,4) NOT NULL DEFAULT 0,
  igst         DECIMAL(19,4) NOT NULL DEFAULT 0,
  cess         DECIMAL(19,4) NOT NULL DEFAULT 0,
  CONSTRAINT fk_itcrcl_reclaim FOREIGN KEY (reclaim_id) REFERENCES itc_reclaims(id) ON DELETE CASCADE,
  CONSTRAINT fk_itcrcl_reversal FOREIGN KEY (reversal_id) REFERENCES itc_reversals(id),
  KEY idx_itcrcl_reversal (reversal_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
