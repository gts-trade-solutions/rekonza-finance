import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Bank statement lines in bulk, as Zoho Books handles them: categorise many
// lines to one account at once, exclude or restore them, delete lines that
// were imported by mistake, undo a whole import — and suggest a category for
// each uncategorised line from how lines like it were categorised before.
//
// The suggestions are learnt from this book's own history, nothing else: a
// line's narration is broken into words (dropping the NEFT/UPI/IMPS noise
// every narration carries, and the reference numbers), and the past line that
// shares the most of them, in the same direction, lends its account. They are
// offered, never applied on their own; a person accepts them, one by one or
// all at once.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import { badRequest, notFound } from '../http';
import { categoriseTransaction } from './banking';

type Status = 'unmatched' | 'matched' | 'excluded' | 'manually_added';

async function linesOf(trx: Executor, orgId: number, ids: number[]) {
  if (!ids.length) throw badRequest('Choose at least one line.');
  return trx.selectFrom('bank_transactions').select(['id', 'status', 'import_batch_id'])
    .where('org_id', '=', orgId).where('id', 'in', ids).execute();
}

/** Every chosen line that is not yet matched gets one balanced entry against the account. */
export async function bulkCategorise(
  trx: Trx, orgId: number, userId: number | null, ids: number[],
  input: { accountId: number; contactId?: number | null; description?: string | null },
): Promise<{ categorised: number; skipped: number }> {
  const account = await trx.selectFrom('accounts').select('id').where('id', '=', input.accountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!account) throw notFound('That account does not exist.');
  const lines = await linesOf(trx, orgId, ids);
  let categorised = 0;
  for (const l of lines) {
    if (l.status !== 'unmatched' && l.status !== 'excluded') continue;
    await categoriseTransaction(trx, orgId, userId, l.id, input);
    categorised++;
  }
  return { categorised, skipped: ids.length - categorised };
}

/** Each line its own suggested account, as accepted on screen. */
export async function acceptSuggestions(
  trx: Trx, orgId: number, userId: number | null, picks: { id: number; accountId: number }[],
): Promise<number> {
  let n = 0;
  for (const p of picks) {
    const [l] = await linesOf(trx, orgId, [p.id]);
    if (!l || l.status !== 'unmatched') continue;
    await categoriseTransaction(trx, orgId, userId, p.id, { accountId: p.accountId });
    n++;
  }
  return n;
}

/**
 * Excluded lines are kept but left out of reconciliation: a duplicate the
 * bank itself printed twice, a line belonging to another business.
 */
export async function setExcluded(trx: Trx, orgId: number, ids: number[], excluded: boolean): Promise<number> {
  const from: Status = excluded ? 'unmatched' : 'excluded';
  const r = await trx.updateTable('bank_transactions').set({ status: excluded ? 'excluded' : 'unmatched' })
    .where('org_id', '=', orgId).where('id', 'in', ids).where('status', '=', from).executeTakeFirst();
  return Number(r.numUpdatedRows);
}

/**
 * Lines imported by mistake. Only lines nothing hangs on: a matched line has
 * an entry or a payment behind it, and must be unmatched first.
 */
export async function deleteLines(trx: Trx, orgId: number, ids: number[]): Promise<{ deleted: number; kept: number }> {
  const lines = await linesOf(trx, orgId, ids);
  const free = lines.filter((l) => l.status === 'unmatched' || l.status === 'excluded').map((l) => l.id);
  if (free.length) await trx.deleteFrom('bank_transactions').where('org_id', '=', orgId).where('id', 'in', free).execute();
  return { deleted: free.length, kept: lines.length - free.length };
}

/**
 * Undo an import: its lines that are still uncategorised go, and with them
 * the import itself once nothing of it is left. Lines already matched stay —
 * the books have moved on from them — and the count says so.
 */
export async function undoImport(trx: Trx, orgId: number, importId: number): Promise<{ removed: number; kept: number }> {
  const imp = await trx.selectFrom('bank_statement_imports').select(['id', 'rows_imported'])
    .where('id', '=', importId).where('org_id', '=', orgId).executeTakeFirst();
  if (!imp) throw notFound('That import was not found.');
  const lines = await trx.selectFrom('bank_transactions').select(['id', 'status'])
    .where('org_id', '=', orgId).where('import_batch_id', '=', importId).execute();
  const free = lines.filter((l) => l.status === 'unmatched' || l.status === 'excluded').map((l) => l.id);
  if (free.length) await trx.deleteFrom('bank_transactions').where('id', 'in', free).execute();
  const kept = lines.length - free.length;
  if (kept === 0) await trx.deleteFrom('bank_statement_imports').where('id', '=', importId).execute();
  else await trx.updateTable('bank_statement_imports').set({ rows_imported: kept }).where('id', '=', importId).execute();
  return { removed: free.length, kept };
}

// ── Suggestions ──────────────────────────────────────────────────────────────

const NOISE = new Set([
  'NEFT', 'RTGS', 'IMPS', 'UPI', 'CR', 'DR', 'TO', 'BY', 'FROM', 'REF', 'TRF', 'TRANSFER', 'INB', 'MOB', 'PAYMENT', 'PAY',
  'ACH', 'NACH', 'ECS', 'CHQ', 'CHEQUE', 'POS', 'ATM', 'BANK', 'LTD', 'PVT', 'THE', 'AND', 'FOR', 'INR', 'TXN', 'NO',
  'BIL', 'ONL', 'IB', 'NET', 'BANKING', 'DEP', 'WDL', 'CASH', 'CLG', 'INWARD', 'OUTWARD', 'SBIN', 'HDFC', 'ICIC', 'UTIB', 'KKBK',
]);

/** The words of a narration that say who or what, without the payment-rail noise or reference numbers. */
export function narrationWords(narration: string): Set<string> {
  return new Set(
    narration.toUpperCase().split(/[^A-Z0-9]+/)
      .filter((w) => w.length >= 3 && !/\d/.test(w) && !NOISE.has(w)),
  );
}

export interface CategorySuggestion {
  accountId: string;
  code: string;
  name: string;
  /** 0 to 1: how much of the narration the past line shared. */
  confidence: number;
  /** The past narration it was learnt from. */
  basedOn: string;
  /** How many past lines put this kind of narration there. */
  times: number;
}

export async function suggestCategories(
  ex: Executor, orgId: number,
  lines: { id: number; narration: string; inflow: boolean }[],
): Promise<Map<number, CategorySuggestion>> {
  const out = new Map<number, CategorySuggestion>();
  if (!lines.length) return out;
  // The latest categorised lines, each with the account on the other side.
  const { rows: past } = await sql<{ narration: string; inflow: number; account_id: number; code: string; name: string }>`
    SELECT t.narration, t.deposit > 0 AS inflow, jl.account_id, a.code, a.name
      FROM bank_transactions t
      JOIN bank_accounts b ON b.id = t.bank_account_id
      JOIN journal_lines jl ON jl.entry_id = t.matched_id AND jl.account_id <> b.ledger_account_id
      JOIN accounts a ON a.id = jl.account_id
     WHERE t.org_id = ${orgId} AND t.status = 'matched' AND t.matched_type = 'journal_entry'
     ORDER BY t.id DESC
     LIMIT 3000
  `.execute(ex);
  const learnt = past.map((p) => ({ ...p, words: narrationWords(p.narration), inflow: Number(p.inflow) === 1 }));

  for (const l of lines) {
    const words = narrationWords(l.narration);
    if (!words.size) continue;
    const byAccount = new Map<number, { score: number; times: number; basedOn: string; code: string; name: string }>();
    for (const p of learnt) {
      if (p.inflow !== l.inflow || !p.words.size) continue;
      let shared = 0;
      let long = false;
      for (const w of words) if (p.words.has(w)) { shared++; if (w.length >= 4) long = true; }
      if (!shared || !long) continue;
      const score = shared / (words.size + p.words.size - shared);
      const have = byAccount.get(p.account_id);
      if (!have) byAccount.set(p.account_id, { score, times: 1, basedOn: p.narration, code: p.code, name: p.name });
      else {
        have.times++;
        if (score > have.score) Object.assign(have, { score, basedOn: p.narration });
      }
    }
    let best: [number, { score: number; times: number; basedOn: string; code: string; name: string }] | null = null;
    for (const e of byAccount) {
      // Seen more often counts for a little: three past lines agreeing beat one.
      const rank = e[1].score + Math.min(e[1].times - 1, 4) * 0.05;
      if (!best || rank > best[1].score + Math.min(best[1].times - 1, 4) * 0.05) best = e;
    }
    if (best && best[1].score >= 0.34) {
      out.set(l.id, {
        accountId: String(best[0]), code: best[1].code, name: best[1].name,
        confidence: Math.min(1, Math.round((best[1].score + Math.min(best[1].times - 1, 4) * 0.05) * 100) / 100),
        basedOn: best[1].basedOn, times: best[1].times,
      });
    }
  }
  return out;
}
