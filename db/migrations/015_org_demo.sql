-- 015_org_demo.sql
-- Separate the demo book from real ones.
--
-- Until now there was exactly one organisation and it was the seeded demo, so
-- nothing had to tell them apart. Once anybody can register, the two live in
-- the same database side by side, and the difference matters in several places
-- at once: the app has to say "this is illustrative, nothing is filed" on the
-- demo and stay silent on a real book; the seed script has to be able to wipe
-- and rebuild the demo without touching a customer's ledger; and the one-click
-- "open the demo" door must only ever open onto an organisation that was
-- deliberately marked as a demo.
--
-- A flag on the organisation is the whole mechanism. It defaults to 0, so every
-- organisation created from the sign-up form is real unless something says
-- otherwise — the safe direction for a default to fail in.

ALTER TABLE organizations
  ADD COLUMN is_demo TINYINT(1) NOT NULL DEFAULT 0 AFTER onboarded_at;

-- The existing row, if there is one, is the seeded demo book.
UPDATE organizations SET is_demo = 1;

CREATE INDEX idx_org_demo ON organizations (is_demo);
