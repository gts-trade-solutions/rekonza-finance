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

/** Keep the record of a document that is about to go. */
export async function recordDeletion(trx: Trx, d: DeletedDoc): Promise<void> {
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
    reason: d.reason?.trim().slice(0, 300) || null,
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

/** Plain rows for the snapshot: dates as text, decimals as they are. */
export function plain<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = v instanceof Date ? v.toISOString() : v;
  return out;
}
