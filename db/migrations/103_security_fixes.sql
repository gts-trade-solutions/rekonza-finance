-- Fixes from the security review before production.

-- A comment is on the portal only when it belongs to the portal conversation:
-- one the customer or vendor wrote there, or the business's reply to it. Staff
-- notes on the same document ("chase hard, disputed") stay inside.
ALTER TABLE comments ADD COLUMN portal_visible TINYINT(1) NOT NULL DEFAULT 0;
UPDATE comments SET portal_visible = 1 WHERE user_id IS NULL;

-- A new email address from the portal waits for the business, as new bank
-- details do: it decides where invoices and sign-in codes go.
ALTER TABLE portal_requests MODIFY COLUMN kind ENUM('bank_details','email') NOT NULL;

-- Attempts counted per window, for sign-in and portal codes: per address and
-- per email, so neither guessing many passwords from one place nor one
-- password across many accounts goes unchecked (lib/server/auth/throttle.ts).
CREATE TABLE IF NOT EXISTS auth_throttle (
  bucket        VARCHAR(100) NOT NULL PRIMARY KEY,
  hits          INT          NOT NULL DEFAULT 0,
  window_start  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
