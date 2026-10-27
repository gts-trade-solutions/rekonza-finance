-- 017_analytics.sql
-- Analytics: data people bring to the app, and the reports they build on it.
--
-- Two tables, deliberately separate. A dataset is the data — rows and a column
-- schema — and a report is a *view* of it: which charts, which filters, in what
-- layout. One dataset feeds many reports, and rebuilding a chart never touches
-- the rows. It is the same split Tableau makes between a data source and a
-- workbook, and OneStream between a cube and a cube view.
--
-- Nothing here is part of the ledger. Analytics works on copies — an uploaded
-- spreadsheet, or a snapshot taken from the books at a stated time — and a
-- chart can never post, alter or reveal anything the ledger itself does not.

-- ── Datasets ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS analytics_datasets (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  name                VARCHAR(150)  NOT NULL,
  description         VARCHAR(500)  NULL,
  -- Where the rows came from. 'books' is a snapshot of this organisation's own
  -- documents, and says so on screen with the time it was taken, because a
  -- snapshot that looks live is a number somebody will quote after it changed.
  source              ENUM('upload','paste','books','sample') NOT NULL,
  -- The file name, the sheet, or the name of the books extract.
  source_name         VARCHAR(255)  NULL,
  row_count           INT           NOT NULL,
  column_count        SMALLINT      NOT NULL,
  -- The column schema: label, type, role, format, and the profile taken at
  -- import. Small, read on every list, so it lives apart from the rows.
  columns_json        JSON          NOT NULL,
  -- The rows themselves, as a JSON array of arrays in column order. An array
  -- per row rather than an object keeps a 50,000-row dataset to a size the
  -- browser can take in one response; the schema supplies the names.
  --
  -- LONGTEXT rather than JSON: MySQL would parse and re-serialise a JSON
  -- column on every write for no benefit, since nothing queries inside it.
  data_json           LONGTEXT      NOT NULL,
  size_bytes          INT           NOT NULL,
  -- Set for snapshots from the books: when the rows were copied.
  refreshed_at        DATETIME      NULL,
  created_by_user_id  BIGINT        NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_ads_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  KEY idx_ads_org (org_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Reports ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS analytics_reports (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  -- One dataset per report, so one filter bar can scope every tile on it and
  -- the numbers on screen always describe the same slice.
  dataset_id          BIGINT        NOT NULL,
  name                VARCHAR(150)  NOT NULL,
  description         VARCHAR(500)  NULL,
  -- 'private' is visible to its author alone; 'org' to everyone with access
  -- to Analytics. Defaults to private — sharing is a decision, not an accident.
  visibility          ENUM('private','org') NOT NULL DEFAULT 'private',
  -- The tiles: each one a chart specification and a width on a 12-column grid.
  layout_json         JSON          NOT NULL,
  -- The report-wide filter bar's saved state.
  filters_json        JSON          NULL,
  created_by_user_id  BIGINT        NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_arp_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  -- RESTRICT, not CASCADE: deleting a dataset must not silently take every
  -- report built on it. The app refuses and names the reports instead.
  CONSTRAINT fk_arp_dataset FOREIGN KEY (dataset_id) REFERENCES analytics_datasets(id)
    ON DELETE RESTRICT,
  KEY idx_arp_org (org_id, updated_at),
  KEY idx_arp_dataset (dataset_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
