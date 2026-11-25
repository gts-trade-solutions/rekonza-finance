import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// What a report row of a journal entry needs to offer View, Edit and Delete on
// it, as the General Ledger does (components/reports/ledger-entry-actions.tsx):
// the document behind the entry, and whether the entry is a reversal or has
// been reversed (then it is read, not changed).
//
// Two kinds of document used to post their entry before they had an id of
// their own to put on it — a bank transfer and a cash count — so their older
// entries carry no source id. They are found the other way round, by the
// document's journal_entry_id, so every row can still reach its document.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor } from '../db';

export interface EntryRef { entryId: string; entryNo: number }
export interface EntryLinks { reversalOf: EntryRef | null; reversedBy: EntryRef | null }

/** Each entry's reversal links: what it reverses, and the first entry that reverses it. */
export async function entryLinks(ex: Executor, orgId: number, entryIds: number[]): Promise<Map<number, EntryLinks>> {
  const out = new Map<number, EntryLinks>();
  const ids = [...new Set(entryIds.filter((x) => Number.isFinite(x)))];
  if (!ids.length) return out;
  const own = await ex.selectFrom('journal_entries as e').leftJoin('journal_entries as o', 'o.id', 'e.reversal_of_entry_id')
    .select(['e.id', 'e.reversal_of_entry_id', 'o.entry_no as of_no'])
    .where('e.org_id', '=', orgId).where('e.id', 'in', ids).execute();
  const by = await ex.selectFrom('journal_entries').select(['id', 'entry_no', 'reversal_of_entry_id'])
    .where('org_id', '=', orgId).where('reversal_of_entry_id', 'in', ids).orderBy('id').execute();
  const firstBy = new Map<number, EntryRef>();
  for (const r of by) {
    const k = Number(r.reversal_of_entry_id);
    if (!firstBy.has(k)) firstBy.set(k, { entryId: String(r.id), entryNo: r.entry_no });
  }
  for (const e of own) {
    out.set(e.id, {
      reversalOf: e.reversal_of_entry_id ? { entryId: String(e.reversal_of_entry_id), entryNo: Number(e.of_no) } : null,
      reversedBy: firstBy.get(e.id) ?? null,
    });
  }
  return out;
}

/** Documents that point at their entry rather than the other way round. */
const BY_ENTRY: Record<string, 'bank_transfers' | 'cash_counts'> = { transfer: 'bank_transfers', cash_count: 'cash_counts' };

/**
 * The document id of each entry that carries none of its own (an older
 * transfer or cash count), keyed by entry id.
 */
export async function missingSourceIds(ex: Executor, orgId: number, rows: { entryId: number; sourceType: string; sourceId: unknown }[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const [kind, table] of Object.entries(BY_ENTRY)) {
    const ids = rows.filter((r) => r.sourceType === kind && (r.sourceId === null || r.sourceId === undefined)).map((r) => r.entryId);
    if (!ids.length) continue;
    const found = await ex.selectFrom(table).select(['id', 'journal_entry_id']).where('org_id', '=', orgId).where('journal_entry_id', 'in', ids).execute();
    for (const f of found) if (f.journal_entry_id) out.set(f.journal_entry_id, String(f.id));
  }
  return out;
}
