-- 018_ai_billing.sql
-- The AI assistant, the credits that pay for it, and how those credits are bought.
--
-- Three groups of tables, kept apart because they change for different reasons:
--
--   ai_*        what the assistant did — conversations, and one usage row per
--               question with the tokens it actually consumed
--   ai_credit_* the organisation's credit wallet, as grants with their own
--               expiry dates and an append-only ledger of every movement
--   billing_*   money: Razorpay orders and subscriptions, the payments that
--               came of them, and the tax invoice issued for each payment
--
-- Credits are stored in millicredits (1 credit = 1000) so a question that cost
-- 2.07 credits is charged 2.07 credits, not rounded up to 3. Money is integer
-- paise, as everywhere else in this application.
--
-- None of this touches the ledger. The assistant reads the books through the
-- same functions the reports use and has no path to write to them.

-- ── Assistant settings ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_settings (
  org_id               BIGINT       NOT NULL PRIMARY KEY,
  -- Off until an admin turns it on. Questions and the figures needed to answer
  -- them are sent to the model provider, which is a decision for the
  -- organisation to make, recorded with who made it and when.
  enabled              TINYINT(1)   NOT NULL DEFAULT 0,
  consent_at           DATETIME     NULL,
  consent_by_user_id   BIGINT       NULL,
  -- The most one person may spend in a calendar month, so a single user cannot
  -- empty the organisation's wallet. NULL means no cap.
  user_monthly_cap_mc  BIGINT       NULL,
  -- The free trial is granted once, the first time the assistant is enabled.
  trial_granted_at     DATETIME     NULL,
  updated_by_user_id   BIGINT       NULL,
  updated_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_ais_org FOREIGN KEY (org_id) REFERENCES organizations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── The wallet ───────────────────────────────────────────────────────────────

-- One row per organisation, and the row every credit movement locks first.
-- `held_mc` is what questions in flight have reserved: a question reserves
-- before it runs and is charged its real cost after, so two questions asked at
-- once can never spend the same credit twice.
CREATE TABLE IF NOT EXISTS ai_wallets (
  org_id      BIGINT     NOT NULL PRIMARY KEY,
  held_mc     BIGINT     NOT NULL DEFAULT 0,
  updated_at  TIMESTAMP  NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_aiw_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT chk_aiw_held CHECK (held_mc >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every grant of credits is a bucket with its own expiry: the trial, each
-- month's plan allowance, each top-up pack. Spending takes from the bucket that
-- expires soonest, so nobody loses credits they could have used first.
CREATE TABLE IF NOT EXISTS ai_credit_buckets (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id           BIGINT        NOT NULL,
  source           ENUM('trial','plan','topup','demo','adjustment') NOT NULL,
  granted_mc       BIGINT        NOT NULL,
  remaining_mc     BIGINT        NOT NULL,
  expires_at       DATETIME      NULL,
  -- What this grant is for — 'trial', 'topup:41', 'plan:7:2026-09-12' — and
  -- unique per organisation. A webhook delivered twice, or a payment confirmed
  -- by both the browser and the webhook, grants once.
  grant_key        VARCHAR(120)  NOT NULL,
  payment_id       BIGINT        NULL,
  subscription_id  BIGINT        NULL,
  note             VARCHAR(255)  NULL,
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_acb_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT chk_acb_remaining CHECK (remaining_mc >= 0 AND remaining_mc <= granted_mc),
  UNIQUE KEY uq_acb_grant (org_id, grant_key),
  KEY idx_acb_spend (org_id, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per question. Created as 'held' with the credits reserved, and
-- settled with the tokens the model actually used. A row stuck in 'held' means
-- the server stopped mid-question; it is released, uncharged, on the next visit.
CREATE TABLE IF NOT EXISTS ai_usage (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT       NOT NULL,
  user_id           BIGINT       NOT NULL,
  conversation_id   BIGINT       NULL,
  status            ENUM('held','settled','failed') NOT NULL DEFAULT 'held',
  outcome           ENUM('answered','stopped','error','abandoned') NULL,
  provider          VARCHAR(30)  NOT NULL,
  model             VARCHAR(80)  NOT NULL,
  hold_mc           BIGINT       NOT NULL,
  charged_mc        BIGINT       NOT NULL DEFAULT 0,
  input_tokens      INT          NOT NULL DEFAULT 0,
  cached_tokens     INT          NOT NULL DEFAULT 0,
  output_tokens     INT          NOT NULL DEFAULT 0,
  reasoning_tokens  INT          NOT NULL DEFAULT 0,
  -- What the provider will bill us, in millionths of a dollar. Kept beside the
  -- credits charged so the margin on every question can be audited.
  cost_micro_usd    BIGINT       NOT NULL DEFAULT 0,
  model_calls       SMALLINT     NOT NULL DEFAULT 0,
  tool_calls        SMALLINT     NOT NULL DEFAULT 0,
  -- Set when the provider never reported usage — a stream cut short — and the
  -- tokens had to be estimated from the text.
  estimated         TINYINT(1)   NOT NULL DEFAULT 0,
  error_code        VARCHAR(60)  NULL,
  duration_ms       INT          NULL,
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  settled_at        DATETIME(3)  NULL,
  CONSTRAINT fk_aiu_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  KEY idx_aiu_org_time (org_id, created_at),
  KEY idx_aiu_user_time (org_id, user_id, created_at),
  KEY idx_aiu_open (org_id, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every movement of credits, never updated or deleted. The balance at any
-- moment is reconstructible from this table alone, which is what settles a
-- dispute about where a customer's credits went.
CREATE TABLE IF NOT EXISTS ai_credit_ledger (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id            BIGINT        NOT NULL,
  bucket_id         BIGINT        NULL,
  kind              ENUM('grant','usage','expiry','refund','adjustment') NOT NULL,
  delta_mc          BIGINT        NOT NULL,
  balance_after_mc  BIGINT        NOT NULL,
  usage_id          BIGINT        NULL,
  user_id           BIGINT        NULL,
  note              VARCHAR(255)  NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_acl_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  KEY idx_acl_org_time (org_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Conversations ────────────────────────────────────────────────────────────

-- Private to the person who asked. An admin sees who spent how many credits,
-- never what they asked.
CREATE TABLE IF NOT EXISTS ai_conversations (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id         BIGINT        NOT NULL,
  user_id        BIGINT        NOT NULL,
  -- Set on the shared demo book only: the sign-in session that started the
  -- conversation. Every visitor to the demo signs in as the same user, and
  -- one visitor must not be able to read another's questions.
  session_key    CHAR(64)      NULL,
  title          VARCHAR(150)  NOT NULL,
  message_count  INT           NOT NULL DEFAULT 0,
  created_at     DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_aic_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  KEY idx_aic_owner (org_id, user_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_messages (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  conversation_id  BIGINT       NOT NULL,
  org_id           BIGINT       NOT NULL,
  role             ENUM('user','assistant') NOT NULL,
  content          MEDIUMTEXT   NOT NULL,
  -- Suggested next questions, and the reports each figure came from.
  followups_json   JSON         NULL,
  sources_json     JSON         NULL,
  status           ENUM('complete','stopped','error') NOT NULL DEFAULT 'complete',
  usage_id         BIGINT       NULL,
  charged_mc       BIGINT       NOT NULL DEFAULT 0,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_aim_conv FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE,
  KEY idx_aim_conv (conversation_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Billing ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS billing_subscriptions (
  id                        BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id                    BIGINT        NOT NULL,
  plan_code                 VARCHAR(20)   NOT NULL,
  period                    ENUM('monthly','yearly') NOT NULL,
  -- Razorpay's own lifecycle, mirrored: created → authenticated → active, then
  -- pending while a failed renewal is retried, halted when retries run out.
  status                    ENUM('created','authenticated','active','pending','halted','paused','cancelled','completed','expired')
                            NOT NULL DEFAULT 'created',
  provider                  ENUM('razorpay','standin') NOT NULL,
  provider_subscription_id  VARCHAR(60)   NULL,
  provider_plan_id          VARCHAR(60)   NULL,
  -- Razorpay's hosted page for the customer to authorise or fix the mandate.
  short_url                 VARCHAR(255)  NULL,
  -- What each cycle charges, GST included.
  amount_paise              BIGINT        NOT NULL,
  current_start             DATETIME      NULL,
  current_end               DATETIME      NULL,
  cancel_at_period_end      TINYINT(1)    NOT NULL DEFAULT 0,
  -- A plan switch waiting for the next renewal.
  pending_plan_code         VARCHAR(20)   NULL,
  ended_at                  DATETIME      NULL,
  -- Event time of the last provider update applied. Webhooks can arrive out of
  -- order; an older event must never undo a newer one.
  provider_synced_at        DATETIME      NULL,
  created_by_user_id        BIGINT        NULL,
  created_at                TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_bsub_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_bsub_provider (provider_subscription_id),
  KEY idx_bsub_org (org_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS billing_payments (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id               BIGINT        NOT NULL,
  kind                 ENUM('topup','subscription') NOT NULL,
  provider             ENUM('razorpay','standin') NOT NULL,
  status               ENUM('created','paid','failed','refunded','partially_refunded') NOT NULL DEFAULT 'created',
  pack_code            VARCHAR(20)   NULL,
  subscription_id      BIGINT        NULL,
  description          VARCHAR(200)  NOT NULL,
  credits              INT           NOT NULL DEFAULT 0,
  -- Computed on the server from the catalogue. The browser never sends an amount.
  taxable_paise        BIGINT        NOT NULL,
  gst_paise            BIGINT        NOT NULL,
  amount_paise         BIGINT        NOT NULL,
  refunded_paise       BIGINT        NOT NULL DEFAULT 0,
  provider_order_id    VARCHAR(60)   NULL,
  provider_payment_id  VARCHAR(60)   NULL,
  method               VARCHAR(30)   NULL,
  failure_reason       VARCHAR(255)  NULL,
  period_start         DATETIME      NULL,
  period_end           DATETIME      NULL,
  created_by_user_id   BIGINT        NULL,
  paid_at              DATETIME      NULL,
  created_at           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_bpay_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_bpay_order (provider_order_id),
  -- One row per real payment, however many times it is reported.
  UNIQUE KEY uq_bpay_payment (provider_payment_id),
  KEY idx_bpay_org (org_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The platform's tax invoice to the organisation for a payment. The seller and
-- buyer are copied in at issue, because a tax invoice states what was true on
-- the day — a later change of address must not rewrite it.
CREATE TABLE IF NOT EXISTS billing_invoices (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id           BIGINT       NOT NULL,
  payment_id       BIGINT       NOT NULL,
  number           VARCHAR(20)  NOT NULL,
  invoice_date     DATE         NOT NULL,
  is_tax_invoice   TINYINT(1)   NOT NULL DEFAULT 1,
  seller_json      JSON         NOT NULL,
  buyer_json       JSON         NOT NULL,
  place_of_supply  CHAR(2)      NULL,
  lines_json       JSON         NOT NULL,
  taxable_paise    BIGINT       NOT NULL,
  cgst_paise       BIGINT       NOT NULL DEFAULT 0,
  sgst_paise       BIGINT       NOT NULL DEFAULT 0,
  igst_paise       BIGINT       NOT NULL DEFAULT 0,
  total_paise      BIGINT       NOT NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_binv_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_binv_payment FOREIGN KEY (payment_id) REFERENCES billing_payments(id),
  UNIQUE KEY uq_binv_number (number),
  UNIQUE KEY uq_binv_payment (payment_id),
  KEY idx_binv_org (org_id, invoice_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Platform-wide counters. The platform's invoices form one unbroken series
-- under its own GSTIN, whichever organisation they are issued to — so this is
-- not the per-organisation `sequences` table.
CREATE TABLE IF NOT EXISTS billing_counters (
  name        VARCHAR(40)  NOT NULL PRIMARY KEY,
  next_value  BIGINT       NOT NULL DEFAULT 1,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The Razorpay plan behind each of ours. Keyed by amount too: when a price
-- changes, a new Razorpay plan is created and existing subscribers stay on the
-- price they signed up for.
CREATE TABLE IF NOT EXISTS billing_plan_links (
  plan_code         VARCHAR(20)  NOT NULL,
  period            ENUM('monthly','yearly') NOT NULL,
  amount_paise      BIGINT       NOT NULL,
  mode              ENUM('test','live') NOT NULL,
  provider_plan_id  VARCHAR(60)  NOT NULL,
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (plan_code, period, amount_paise, mode)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every webhook received, kept whether or not it was acted on. Razorpay
-- delivers at least once; the event id makes a redelivery a no-op, and a
-- failed one is retried rather than skipped.
CREATE TABLE IF NOT EXISTS billing_webhook_events (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  provider_event_id  VARCHAR(80)   NOT NULL,
  event              VARCHAR(60)   NOT NULL,
  org_id             BIGINT        NULL,
  payload            JSON          NOT NULL,
  status             ENUM('received','processed','ignored','failed') NOT NULL DEFAULT 'received',
  error              VARCHAR(500)  NULL,
  attempts           INT           NOT NULL DEFAULT 1,
  received_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  processed_at       DATETIME(3)   NULL,
  UNIQUE KEY uq_bwe_event (provider_event_id),
  KEY idx_bwe_org (org_id, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
