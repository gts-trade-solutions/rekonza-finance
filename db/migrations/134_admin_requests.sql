-- Admin approval of undoing or changing posted work (the client, 2026-11-28):
-- "once the user reversed, it should go to the admin" and "if they need a
-- modification in an invoice they need approval from admin" — then, on the
-- way the admin answers: "not an OTP: the admin needs two buttons, Approve and
-- Reject".
--
-- When someone who is not an admin reverses, voids, deletes or uncategorises
-- posted work, or changes a saved invoice, the request is kept here instead of
-- being carried out, and the admins are told. An admin's Approve carries out
-- that same request, as the person who asked (lib/server/services/admin-requests.ts);
-- Reject leaves everything as it was. Either way the person is told.
CREATE TABLE IF NOT EXISTS admin_requests (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id                BIGINT        NOT NULL,
  requested_by_user_id  BIGINT        NOT NULL,
  -- 'undo' (reverse, void, delete, uncategorise) or 'invoice_edit'.
  kind                  VARCHAR(20)   NOT NULL,
  -- In words, as the admins see it: "reverse journal entry #12".
  label                 VARCHAR(200)  NOT NULL,
  -- The request itself, carried out as it was sent when approved.
  method                VARCHAR(10)   NOT NULL,
  path                  VARCHAR(500)  NOT NULL,
  body                  MEDIUMTEXT    NULL,
  change_reason         VARCHAR(500)  NULL,
  -- The same request asked again while one waits is not asked twice.
  scope                 CHAR(64)      NOT NULL,
  status                ENUM('pending','approved','rejected','done','failed','withdrawn') NOT NULL DEFAULT 'pending',
  decided_by_user_id    BIGINT        NULL,
  decided_at            DATETIME      NULL,
  decision_note         VARCHAR(500)  NULL,
  -- What happened when it was carried out.
  result_status         INT           NULL,
  result_message        VARCHAR(500)  NULL,
  -- A one-time pass for carrying it out, held only while it runs (its hash).
  exec_token_hash       CHAR(64)      NULL,
  exec_expires_at       DATETIME      NULL,
  created_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_admreq_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  KEY idx_admreq_org_status (org_id, status, id),
  KEY idx_admreq_user (org_id, requested_by_user_id, scope, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
