-- Fixes from the independent auditor check (2026-11-28), builder fx-c: the
-- record a reversal, a write-off and an approval decision each leave behind.

-- ── Why a voucher was reversed, on the reversal itself ──────────────────────
--
-- Accountant → Reversed Vouchers showed "Not given" for documents voided or
-- deleted with a reason, because the reason was looked for only in places
-- that did not always hold it: a credit note's void was audited under
-- 'credit-note' while its entry is a 'credit_note', and a payment or transfer
-- deleted from the bank screen kept the reason nowhere the register read.
-- Rule 3(1) of the Companies (Accounts) Rules wants the books to say why an
-- entry was undone, so the reason now travels with the reversing entry
-- (ledger/posting.ts writes it as the reversal is posted, from the reason the
-- person typed in the Void, Delete or Reverse window).
ALTER TABLE journal_entries
  ADD COLUMN reversal_reason VARCHAR(500) NULL AFTER reversal_of_entry_id;

-- Written once, as the reversal is inserted, never afterwards: a posted entry
-- cannot be updated (db/protect/tamper_proof_trail.sql refuses it), so there
-- is no backfill here. Reversals made before this keep their reason where it
-- was kept — the journal reversal request, the deleted document's record, the
-- voided document's own void_reason, or the audit trail — and the register
-- (services/voucher-reversals.ts) reads it from there.

-- ── What a stock adjustment took out of (or put into) stock ─────────────────
--
-- The adjustments list showed a periodic book's write-off at the item's
-- catalogue price (₹100) while the window that recorded it said ₹120, the FIFO
-- cost of the units that actually left (AS 2 / Ind AS 2: issues come from the
-- oldest purchases). A periodic book posts nothing at the adjustment, so there
-- was no entry to read the true figure from. It is now worked out as the
-- adjustment is saved, on both methods, as the stock valuation before it less
-- the valuation after it on its own date (services/stock-changes.ts), and kept
-- here: negative for goods written off, positive for goods found. On a
-- perpetual book it is the same figure the adjustment posts to Inventory.
ALTER TABLE stock_adjustments
  ADD COLUMN value DECIMAL(19,4) NULL AFTER qty_delta;

-- ── A discarded journal is a decision too ───────────────────────────────────
--
-- Approvals → Recent decisions listed what was approved and sent back, but a
-- journal held for approval and then discarded vanished from the history, so
-- the maker-checker trail had a gap an auditor would ask about.
ALTER TABLE approval_actions
  MODIFY COLUMN action ENUM('submitted', 'approved', 'rejected', 'discarded') NOT NULL;

INSERT INTO approval_actions (org_id, document_type, document_id, action, user_id, note, created_at)
SELECT h.org_id, 'journal', h.id, 'discarded', h.decided_by_user_id, h.note, COALESCE(h.decided_at, h.created_at)
  FROM held_journals h
 WHERE h.status = 'discarded' AND h.kind = 'approval'
   AND NOT EXISTS (SELECT 1 FROM approval_actions a
                    WHERE a.org_id = h.org_id AND a.document_type = 'journal' AND a.document_id = h.id AND a.action = 'discarded');
