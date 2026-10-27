-- Fixed assets: a register, two depreciation books, capital work in progress,
-- and what happens when an asset is sold or scrapped.
--
-- The Companies Act book (Schedule II) is the one that is posted: each asset
-- is written down over its useful life, straight-line or written-down value,
-- day by day from when it was put to use. The Income-tax book is a different
-- calculation over the same assets — blocks of assets at prescribed rates,
-- half the rate for an asset used for less than 180 days in the year — and
-- is never posted; it is what the tax return and the deferred tax note need.
--
-- An asset under construction or installation sits in capital work in
-- progress until it is put to use, and depreciation starts only then.

-- ── Ledgers ──────────────────────────────────────────────────────────────────
-- One ledger per class of asset under Fixed Assets, a contra ledger for the
-- depreciation charged so far, CWIP, the expense, and the gain or loss on
-- disposal. 1600 stays as Furniture & Equipment.
INSERT INTO accounts (org_id, code, name, type, subtype, description, is_system, is_active)
SELECT o.id, x.code, x.name, x.type, x.subtype, x.description, x.is_system, 1
  FROM organizations o
  JOIN (
    SELECT '1610' AS code, 'Plant & Machinery' AS name, 'asset' AS type, 'fixed_asset' AS subtype, NULL AS description, 0 AS is_system
    UNION ALL SELECT '1620', 'Computers & Peripherals', 'asset', 'fixed_asset', NULL, 0
    UNION ALL SELECT '1630', 'Vehicles', 'asset', 'fixed_asset', NULL, 0
    UNION ALL SELECT '1640', 'Buildings', 'asset', 'fixed_asset', NULL, 0
    UNION ALL SELECT '1650', 'Capital Work-in-Progress', 'asset', 'cwip',
                     'Cost of assets being built or installed, held until they are put to use', 1
    UNION ALL SELECT '1690', 'Accumulated Depreciation', 'asset', 'fixed_asset',
                     'Depreciation charged so far; a credit balance that nets against the asset ledgers', 1
    UNION ALL SELECT '1695', 'Asset Disposal Clearing', 'asset', 'current',
                     'Holds the sale value of an asset sold by invoice until its disposal is posted', 1
    UNION ALL SELECT '4950', 'Profit on Sale of Fixed Assets', 'income', NULL, NULL, 1
    UNION ALL SELECT '6970', 'Depreciation', 'expense', 'depreciation', 'Charged under Schedule II of the Companies Act', 1
    UNION ALL SELECT '6980', 'Loss on Sale or Discard of Fixed Assets', 'expense', NULL, NULL, 1
  ) x
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id AND a.code = x.code);

-- Profit on sale is other income in Schedule III, not revenue from operations.
UPDATE accounts SET schedule_iii_line = 'other_income' WHERE code = '4950' AND schedule_iii_line IS NULL;

-- ── Classes ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS asset_classes (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id                BIGINT        NOT NULL,
  name                  VARCHAR(100)  NOT NULL,
  account_id            BIGINT        NOT NULL,
  -- Companies Act, Schedule II
  method                ENUM('slm','wdv') NOT NULL DEFAULT 'slm',
  useful_life_years     DECIMAL(5,2)  NOT NULL,
  residual_pct          DECIMAL(5,2)  NOT NULL DEFAULT 5.00,
  -- Income-tax Act: the block and its rate
  it_block              VARCHAR(60)   NOT NULL,
  it_rate_pct           DECIMAL(5,2)  NOT NULL,
  is_intangible         TINYINT(1)    NOT NULL DEFAULT 0,
  created_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ac_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_ac_account FOREIGN KEY (account_id) REFERENCES accounts(id),
  CONSTRAINT ck_ac_life CHECK (useful_life_years > 0),
  UNIQUE KEY uq_ac_name (org_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every existing book gets the usual classes, with Schedule II lives and the
-- Income-tax block rates.
INSERT INTO asset_classes (org_id, name, account_id, method, useful_life_years, residual_pct, it_block, it_rate_pct)
SELECT o.id, x.name, a.id, 'slm', x.life, 5.00, x.block, x.rate
  FROM organizations o
  JOIN (
    SELECT 'Plant & Machinery' AS name, '1610' AS code, 15.00 AS life, 'Plant & machinery (general)' AS block, 15.00 AS rate
    UNION ALL SELECT 'Computers & Peripherals', '1620', 3.00, 'Computers and software', 40.00
    UNION ALL SELECT 'Vehicles', '1630', 8.00, 'Motor cars (non-commercial)', 15.00
    UNION ALL SELECT 'Buildings', '1640', 30.00, 'Buildings (non-residential)', 10.00
    UNION ALL SELECT 'Furniture & Fittings', '1600', 10.00, 'Furniture and fittings', 10.00
  ) x
  JOIN accounts a ON a.org_id = o.id AND a.code = x.code
 WHERE NOT EXISTS (SELECT 1 FROM asset_classes c WHERE c.org_id = o.id AND c.name = x.name);

-- ── The register ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fixed_assets (
  id                      BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id                  BIGINT        NOT NULL,
  branch_id               BIGINT        NOT NULL,
  class_id                BIGINT        NOT NULL,
  tag_no                  VARCHAR(30)   NOT NULL,
  name                    VARCHAR(200)  NOT NULL,
  description             VARCHAR(500)  NULL,
  serial_no               VARCHAR(80)   NULL,
  location                VARCHAR(150)  NULL,
  custodian               VARCHAR(150)  NULL,
  vendor_id               BIGINT        NULL,
  bill_id                 BIGINT        NULL,
  acquired_on             DATE          NOT NULL,
  -- Null while it is still in capital work in progress.
  put_to_use_on           DATE          NULL,
  status                  ENUM('cwip','in_use','disposed') NOT NULL DEFAULT 'cwip',
  -- The asset's own overrides of its class.
  useful_life_years       DECIMAL(5,2)  NULL,
  residual_value          DECIMAL(19,4) NULL,
  -- Brought in at the start of the books: depreciation charged before then.
  opening_accumulated     DECIMAL(19,4) NOT NULL DEFAULT 0,
  -- Credit taken on its purchase, for GST on a later sale (section 18(6)).
  itc_claimed             DECIMAL(19,4) NOT NULL DEFAULT 0,
  hsn_sac                 VARCHAR(10)   NULL,
  insurance_policy_no     VARCHAR(60)   NULL,
  insurance_expiry        DATE          NULL,
  amc_vendor              VARCHAR(150)  NULL,
  amc_expiry              DATE          NULL,
  disposed_on             DATE          NULL,
  disposal_kind           ENUM('sold','scrapped') NULL,
  disposal_value          DECIMAL(19,4) NULL,
  disposal_invoice_id     BIGINT        NULL,
  disposal_entry_id       BIGINT        NULL,
  notes                   VARCHAR(500)  NULL,
  created_by_user_id      BIGINT        NULL,
  created_at              TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_fa_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_fa_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_fa_class FOREIGN KEY (class_id) REFERENCES asset_classes(id),
  CONSTRAINT fk_fa_vendor FOREIGN KEY (vendor_id) REFERENCES contacts(id),
  CONSTRAINT fk_fa_bill FOREIGN KEY (bill_id) REFERENCES bills(id),
  CONSTRAINT fk_fa_invoice FOREIGN KEY (disposal_invoice_id) REFERENCES invoices(id),
  CONSTRAINT fk_fa_entry FOREIGN KEY (disposal_entry_id) REFERENCES journal_entries(id),
  UNIQUE KEY uq_fa_tag (org_id, tag_no),
  KEY idx_fa_status (org_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- What an asset cost, piece by piece: the purchase, the installation, the
-- freight. CWIP collects these until the asset is put to use.
CREATE TABLE IF NOT EXISTS asset_costs (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  asset_id          BIGINT        NOT NULL,
  cost_date         DATE          NOT NULL,
  amount            DECIMAL(19,4) NOT NULL,
  kind              ENUM('purchase','addition','opening') NOT NULL DEFAULT 'purchase',
  description       VARCHAR(300)  NULL,
  bill_id           BIGINT        NULL,
  journal_entry_id  BIGINT        NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_acost_asset FOREIGN KEY (asset_id) REFERENCES fixed_assets(id),
  CONSTRAINT fk_acost_bill FOREIGN KEY (bill_id) REFERENCES bills(id),
  CONSTRAINT fk_acost_entry FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id),
  CONSTRAINT ck_acost_amount CHECK (amount > 0),
  KEY idx_acost_asset (asset_id, cost_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Depreciation (Companies Act book) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS depreciation_runs (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  period_from         DATE          NOT NULL,
  period_to           DATE          NOT NULL,
  total               DECIMAL(19,4) NOT NULL,
  journal_entry_id    BIGINT        NULL,
  -- A run is undone by reversing its entry; the row stays, marked.
  reversed            TINYINT(1)    NOT NULL DEFAULT 0,
  created_by_user_id  BIGINT        NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_dr_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_dr_entry FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id),
  KEY idx_dr_period (org_id, period_to)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS depreciation_lines (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  run_id        BIGINT        NULL,
  org_id        BIGINT        NOT NULL,
  asset_id      BIGINT        NOT NULL,
  period_from   DATE          NOT NULL,
  period_to     DATE          NOT NULL,
  days          INT           NOT NULL,
  amount        DECIMAL(19,4) NOT NULL,
  -- Depreciation up to the day of a disposal is posted with the disposal.
  disposal      TINYINT(1)    NOT NULL DEFAULT 0,
  reversed      TINYINT(1)    NOT NULL DEFAULT 0,
  CONSTRAINT fk_dl_run FOREIGN KEY (run_id) REFERENCES depreciation_runs(id),
  CONSTRAINT fk_dl_asset FOREIGN KEY (asset_id) REFERENCES fixed_assets(id),
  KEY idx_dl_asset (asset_id, period_to)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Income-tax book ──────────────────────────────────────────────────────────
-- The written-down value of each block at the start of a year, as the last
-- tax return carried it. Later years follow from the register.
CREATE TABLE IF NOT EXISTS it_block_openings (
  org_id        BIGINT        NOT NULL,
  fy_start      SMALLINT      NOT NULL,
  it_block      VARCHAR(60)   NOT NULL,
  it_rate_pct   DECIMAL(5,2)  NOT NULL,
  opening_wdv   DECIMAL(19,4) NOT NULL,
  PRIMARY KEY (org_id, fy_start, it_block),
  CONSTRAINT fk_itbo_org FOREIGN KEY (org_id) REFERENCES organizations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Physical verification ────────────────────────────────────────────────────
-- CARO 2020 asks the auditor whether assets were physically verified at
-- reasonable intervals and what became of any discrepancy.
CREATE TABLE IF NOT EXISTS asset_verifications (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id          BIGINT        NOT NULL,
  asset_id        BIGINT        NOT NULL,
  verified_on     DATE          NOT NULL,
  found           TINYINT(1)    NOT NULL,
  `condition`     ENUM('good','needs_repair','unusable') NULL,
  location        VARCHAR(150)  NULL,
  notes           VARCHAR(300)  NULL,
  verified_by_user_id BIGINT    NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_av_asset FOREIGN KEY (asset_id) REFERENCES fixed_assets(id),
  KEY idx_av_asset (asset_id, verified_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- An invoice line may credit an account of its own instead of Sales: an asset
-- sold by invoice credits Asset Disposal Clearing, so the sale is reported to
-- GST like any supply but never counted as revenue.
ALTER TABLE invoice_lines
  ADD COLUMN account_id BIGINT NULL AFTER item_id,
  ADD CONSTRAINT fk_invl_account FOREIGN KEY (account_id) REFERENCES accounts(id);
