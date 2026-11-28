// ─────────────────────────────────────────────────────────────────────────────
// Deleting a document, as Zoho Books lets you, without losing what the law and
// the auditor need (migration 118).
//
// The document's own rows go. What it posted is reversed by a new entry, never
// erased: journal entries cannot be deleted (db/protect). A row in
// deleted_documents keeps its kind, number, date and the whole document as it
// stood, so GSTR-1 table 13 can still count the number as cancelled and the
// auditor can see what was removed, by whom and why. The audit trail gets its
// own line from the route, as for every other change.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import { sql } from 'kysely';
import type { Trx } from '../db';
import { reverseEntry } from '../ledger/posting';
import type { LockModule } from '../ledger/posting';
import { toSqlFromPaise } from '../money-sql';
import { ApiError } from '../http';
import { changeReason, inRequest } from '../request-context';

export interface DeletedDoc {
  orgId: number;
  userId: number | null;
  docType: string;
  docId: number;
  number: string | null;
  date: string | null;
  totalPaise?: number | null;
  contactId?: number | null;
  branchId?: number | null;
  journalEntryId?: number | null;
  reversalEntryId?: number | null;
  reason?: string | null;
  snapshot: unknown;
}

/**
 * Keep the record of a document that is about to go.
 *
 * Deleting a posted document posts a reversing entry, and the books must say
 * why (Companies (Accounts) Rules, rule 3(1); Accountant → Reversed Vouchers
 * shows it). So when a person's delete reverses an entry and no reason came
 * with it — in the window's reason box (?reason=), or answered to the browser's
 * own question (X-Change-Reason) — the request is answered 428
 * reason_required: the browser asks for one and sends the delete again
 * (lib/api/client.ts), so no screen can delete posted work without a reason.
 * A service called outside a request (a test, a seed) is not asked.
 */
export async function recordDeletion(trx: Trx, d: DeletedDoc): Promise<void> {
  const reason = (d.reason?.trim() || changeReason()?.trim() || '').slice(0, 300) || null;
  if (!reason && d.reversalEntryId && inRequest()) {
    throw new ApiError(428, 'Say why you are deleting it: its entry is reversed in the ledger, and the reason is kept with the reversal and in the audit trail.', 'reason_required');
  }
  await trx.insertInto('deleted_documents').values({
    org_id: d.orgId,
    branch_id: d.branchId ?? null,
    doc_type: d.docType,
    doc_id: d.docId,
    number: d.number,
    doc_date: d.date,
    total: d.totalPaise == null ? null : toSqlFromPaise(d.totalPaise),
    contact_id: d.contactId ?? null,
    journal_entry_id: d.journalEntryId ?? null,
    reversal_entry_id: d.reversalEntryId ?? null,
    reason,
    snapshot: JSON.stringify(d.snapshot, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)),
    deleted_by_user_id: d.userId,
  }).execute();
}

/**
 * Take back what a document posted, for an edit or a delete: a reversing entry
 * on the original date, so the period it was in nets to nothing. A closed
 * period refuses it, as it refuses any posting (transaction locks).
 */
export async function reverseForChange(
  trx: Trx, orgId: number, entryId: number | null | undefined,
  opts: { memo: string; userId: number | null; module: LockModule },
): Promise<number | null> {
  if (!entryId) return null;
  const reversal = await reverseEntry(trx, orgId, entryId, opts);
  return reversal.id;
}

/**
 * What hangs off a document by type and id rather than by a key: comments,
 * custom field values, reporting tags. They go with it. Attachments are kept
 * (unlinked, still in Documents): a file somebody uploaded is not lost.
 */
export async function unlinkDocument(trx: Trx, orgId: number, type: string, id: number): Promise<void> {
  await trx.deleteFrom('comments').where('org_id', '=', orgId).where('target_type', '=', type).where('target_id', '=', id).execute();
  await trx.deleteFrom('reporting_tag_links').where('org_id', '=', orgId).where('entity', '=', type).where('entity_id', '=', id).execute();
  await sql`
    DELETE v FROM custom_field_values v JOIN custom_fields f ON f.id = v.field_id
     WHERE v.org_id = ${orgId} AND f.entity = ${type} AND v.entity_id = ${id}
  `.execute(trx);
  await trx.updateTable('files').set({ attached_to_type: null, attached_to_id: null })
    .where('org_id', '=', orgId).where('attached_to_type', '=', type).where('attached_to_id', '=', id).execute();
}

/**
 * Whether a bank statement line is matched to this document: by its own
 * match, or as one of several (migration 119's links). Such a document is
 * unmatched in Banking before it can be changed or deleted.
 */
export async function bankLineMatched(trx: Trx, orgId: number, type: 'payment' | 'expense' | 'journal_entry' | 'transfer', id: number): Promise<boolean> {
  const direct = await trx.selectFrom('bank_transactions').select('id').where('org_id', '=', orgId)
    .where('matched_type', '=', type).where('matched_id', '=', id).where('status', '=', 'matched').executeTakeFirst();
  if (direct) return true;
  const linked = await trx.selectFrom('bank_transaction_links as l').innerJoin('bank_transactions as t', 't.id', 'l.bank_transaction_id')
    .select('l.id').where('l.org_id', '=', orgId).where('l.target_type', '=', type).where('l.target_id', '=', id)
    .where('t.status', '=', 'matched').executeTakeFirst();
  return !!linked;
}

/** Plain rows for the snapshot: dates as text, decimals as they are. */
export function plain<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = v instanceof Date ? v.toISOString() : v;
  return out;
}
