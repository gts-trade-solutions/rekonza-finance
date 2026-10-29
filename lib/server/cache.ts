import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Caching a book's heavy figures until the book changes.
//
// The dashboard is sixteen aggregates over the whole journal, asked for every
// time anyone opens the app. Recomputing them when nothing has been posted
// since buys nothing. So the answer is kept in this process against the
// book's version — its latest journal entry, and the latest change to an
// invoice, bill or e-invoice (their status and dues move without a posting),
// and the bank statement lines and how many are unmatched —
// and handed back while that version holds. A posting, a payment, an edit:
// the version moves, and the next request computes afresh. A cached figure is
// therefore never out of date, only not yet recomputed for nothing.
//
// Per process and bounded: a few hundred books' worth, oldest dropped first.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from './db';

const MAX_ENTRIES = 500;
const TTL_MS = 10 * 60_000;

interface Entry { version: string; at: number; value: unknown }
const store = new Map<string, Entry>();

/** What the book's figures depend on, as one string: any change moves it. */
export async function booksVersion(ex: Executor, orgId: number): Promise<string> {
  const { rows } = await sql<{ je: string | null; inv: Date | null; bill: Date | null; ein: Date | null; pay: string | null; bank: string | null; open: string | null }>`
    SELECT (SELECT MAX(id) FROM journal_entries WHERE org_id = ${orgId}) AS je,
           (SELECT MAX(updated_at) FROM invoices WHERE org_id = ${orgId}) AS inv,
           (SELECT MAX(updated_at) FROM bills WHERE org_id = ${orgId}) AS bill,
           (SELECT MAX(updated_at) FROM einvoices WHERE org_id = ${orgId}) AS ein,
           (SELECT COUNT(*) FROM payments WHERE org_id = ${orgId} AND status = 'void') AS pay,
           (SELECT MAX(id) FROM bank_transactions WHERE org_id = ${orgId}) AS bank,
           (SELECT COUNT(*) FROM bank_transactions WHERE org_id = ${orgId} AND status = 'unmatched') AS open
  `.execute(ex);
  const r = rows[0];
  const t = (d: Date | null) => (d ? new Date(d).getTime() : 0);
  return `${r?.je ?? 0}:${t(r?.inv ?? null)}:${t(r?.bill ?? null)}:${t(r?.ein ?? null)}:${r?.pay ?? 0}:${r?.bank ?? 0}:${r?.open ?? 0}`;
}

/** The value for `key` at this version, computing it only when the version has moved. */
export async function cachedFor<T>(key: string, version: string, compute: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.version === version && Date.now() - hit.at < TTL_MS) return hit.value as T;
  const value = await compute();
  store.delete(key);
  store.set(key, { version, at: Date.now(), value });
  if (store.size > MAX_ENTRIES) store.delete(store.keys().next().value as string);
  return value;
}
