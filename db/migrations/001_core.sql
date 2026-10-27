-- 001_core.sql
-- Organisation, branches, users, sessions, audit.
--
-- Every business table in this schema carries org_id. Today it holds a single
-- value, because this is a single-company install. It is present anyway because
-- adding a tenant key to forty-odd tables afterwards means rewriting every
-- query, every index and every foreign key at once — the column costs 8 bytes a
-- row now and saves a migration nobody wants to run later.

CREATE TABLE IF NOT EXISTS organizations (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  name                  VARCHAR(200)  NOT NULL,
  legal_name            VARCHAR(200)  NULL,
  pan                   CHAR(10)      NULL,
  -- 'regular' businesses charge GST and claim input credit; 'composition'
  -- pays a flat rate and may claim none; 'unregistered' charges no GST at all.
  gst_registration_type ENUM('regular','composition','unregistered') NOT NULL DEFAULT 'regular',
  -- Aggregate turnover above Rs 5 crore makes e-invoicing mandatory.
  aato_above_5cr        TINYINT(1)    NOT NULL DEFAULT 0,
  -- 4 = April. India's financial year runs 1 April to 31 March; the column
  -- exists so the fiscal calendar is data rather than a hard-coded constant.
  fiscal_year_start_month TINYINT     NOT NULL DEFAULT 4,
  base_currency         CHAR(3)       NOT NULL DEFAULT 'INR',
  address               VARCHAR(500)  NULL,
  email                 VARCHAR(255)  NULL,
  phone                 VARCHAR(30)   NULL,
  logo_file_id          BIGINT        NULL,
  onboarded_at          DATETIME      NULL,
  created_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A branch is a GST registration, not an office. Each state you operate in
-- needs its own GSTIN, and each GSTIN keeps its own invoice number series.
CREATE TABLE IF NOT EXISTS branches (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id        BIGINT        NOT NULL,
  name          VARCHAR(150)  NOT NULL,
  gstin         CHAR(15)      NULL,
  state_code    CHAR(2)       NOT NULL,
  address       VARCHAR(500)  NULL,
  is_primary    TINYINT(1)    NOT NULL DEFAULT 0,
  is_active     TINYINT(1)    NOT NULL DEFAULT 1,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_branches_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_branch_gstin (gstin),
  KEY idx_branches_org (org_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id          BIGINT        NOT NULL,
  name            VARCHAR(150)  NOT NULL,
  email           VARCHAR(255)  NOT NULL,
  -- argon2id. Null means the account exists but cannot sign in yet (invited).
  password_hash   VARCHAR(255)  NULL,
  role            ENUM('admin','accountant','sales','purchase','viewer') NOT NULL DEFAULT 'viewer',
  home_branch_id  BIGINT        NULL,
  phone           VARCHAR(30)   NULL,
  is_active       TINYINT(1)    NOT NULL DEFAULT 1,
  -- Rate limiting for sign-in, so a stolen email cannot be brute forced.
  failed_logins   SMALLINT      NOT NULL DEFAULT 0,
  locked_until    DATETIME      NULL,
  last_login_at   DATETIME      NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_users_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_users_branch FOREIGN KEY (home_branch_id) REFERENCES branches(id),
  UNIQUE KEY uq_users_org_email (org_id, email),
  KEY idx_users_org (org_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which branches a user may raise documents against. A user with no rows here
-- is limited to their home branch.
CREATE TABLE IF NOT EXISTS user_branches (
  user_id   BIGINT NOT NULL,
  branch_id BIGINT NOT NULL,
  PRIMARY KEY (user_id, branch_id),
  CONSTRAINT fk_ub_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_ub_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sessions are server-side so a signed-out or disabled user loses access
-- immediately, which a self-contained JWT cannot do.
CREATE TABLE IF NOT EXISTS sessions (
  -- SHA-256 of the cookie value. The raw token is never stored, so a database
  -- leak does not hand over live sessions.
  token_hash    CHAR(64)      NOT NULL PRIMARY KEY,
  user_id       BIGINT        NOT NULL,
  org_id        BIGINT        NOT NULL,
  active_branch_id BIGINT     NULL,
  ip            VARCHAR(64)   NULL,
  user_agent    VARCHAR(500)  NULL,
  expires_at    DATETIME      NOT NULL,
  revoked_at    DATETIME      NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  DATETIME      NULL,
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  KEY idx_sessions_user (user_id),
  KEY idx_sessions_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- MCA Rule 11(g) requires an audit trail that cannot be switched off and is
-- retained for eight years. Insert-only by policy: there is no update or delete
-- path to this table anywhere in the application.
CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id        BIGINT        NOT NULL,
  actor_user_id BIGINT        NULL,
  actor_name    VARCHAR(150)  NULL,
  action        VARCHAR(40)   NOT NULL,
  target_type   VARCHAR(50)   NULL,
  target_id     VARCHAR(64)   NULL,
  target_label  VARCHAR(200)  NULL,
  detail        VARCHAR(1000) NULL,
  payload       JSON          NULL,
  ip            VARCHAR(64)   NULL,
  user_agent    VARCHAR(500)  NULL,
  created_at    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_audit_org_time (org_id, created_at),
  KEY idx_audit_target (org_id, target_type, target_id),
  KEY idx_audit_actor (org_id, actor_user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
