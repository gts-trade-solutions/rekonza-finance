import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Import history (status review 7, item 3): every import that kept anything,
// with who ran it, when, from which file, how many rows went in, were skipped
// as already in the books, or failed and why — the trail an auditor reads to
// see how master data came into the books (Companies Act s.128: the books and
// how they were made up are kept; Rule 3(1) of the Companies (Accounts) Rules
// asks for the audit trail of every change).
//
// An import of masters (customers and vendors, items, accounts) that nothing
// has used since can be undone whole: what it made is deleted, and the entry
// stays, marked undone. Anything used by a document, a payment or the ledger
// refuses the undo by name, so nothing posted is ever taken from under it.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import { badRequest, conflict, notFound } from '../http';
import type { ImportOutcome, ImportRowError } from '../imports/run';
import { itemUses } from './item-activity';

const MASTER_TABLES = ['contacts', 'items', 'accounts'] as const;

export interface ImportBatchRow {
  id: string;
  module: string;
  kind: string;
  fileName: string | null;
  fileFormat: string | null;
  mode: 'all' | 'valid_only';
  rowsTotal: number;
  imported: number;
  skipped: number;
  failed: number;
  note: string | null;
  status: 'imported' | 'undone';
  by: string | null;
  at: string;
  undoneBy: string | null;
  undoneAt: string | null;
  /** Whether an undo is offered: masters only, and not undone already. */
  undoable: boolean;
}

/** Write the history entry of an import that kept something. */
export async function recordImportBatch(trx: Trx, orgId: number, userId: number | null, input: {
  module: string; kind: string; fileName?: string | null; fileFormat?: string | null; mode: 'all' | 'valid_only'; outcome: ImportOutcome;
}): Promise<number> {
  const o = input.outcome;
  const failedRows = new Set(o.errors.map((e) => e.row)).size;
  const errors: ImportRowError[] = [...o.errors, ...(o.skippedRows ?? [])].slice(0, 2000);
  return Number((await trx.insertInto('import_batches').values({
    org_id: orgId, module: input.module.slice(0, 40), kind: input.kind.slice(0, 40), file_name: input.fileName?.slice(0, 255) ?? null,
    file_format: input.fileFormat?.slice(0, 12) ?? null, mode: input.mode, rows_total: o.rows, imported: o.created, skipped: o.skipped, failed: failedRows,
    errors: JSON.stringify(errors), created_ids: JSON.stringify(o.createdIds ?? {}), status: 'imported', created_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);
}

const json = <T>(v: unknown, fallback: T): T => {
  if (v == null) return fallback;
  if (typeof v === 'string') { try { return JSON.parse(v) as T; } catch { return fallback; } }
  return v as T;
};

export async function listImportBatches(ex: Executor, orgId: number, opts: { module?: string | null } = {}): Promise<ImportBatchRow[]> {
  const rows = await ex.selectFrom('import_batches as b').leftJoin('users as u', 'u.id', 'b.created_by_user_id').leftJoin('users as v', 'v.id', 'b.undone_by_user_id')
    .select(['b.id', 'b.module', 'b.kind', 'b.file_name', 'b.file_format', 'b.mode', 'b.rows_total', 'b.imported', 'b.skipped', 'b.failed', 'b.note', 'b.status',
      'u.name as by', 'b.created_at', 'v.name as undone_by', 'b.undone_at', 'b.created_ids'])
    .where('b.org_id', '=', orgId).$if(!!opts.module, (q) => q.where('b.module', '=', opts.module!))
    .orderBy('b.created_at', 'desc').orderBy('b.id', 'desc').limit(500).execute();
  return rows.map((r) => {
    const ids = json<Record<string, number[]>>(r.created_ids, {});
    const masters = Object.keys(ids).length > 0 && Object.keys(ids).every((t) => (MASTER_TABLES as readonly string[]).includes(t));
    return {
      id: String(r.id), module: r.module, kind: r.kind, fileName: r.file_name, fileFormat: r.file_format, mode: r.mode,
      rowsTotal: r.rows_total, imported: r.imported, skipped: r.skipped, failed: r.failed, note: r.note, status: r.status,
      by: r.by, at: new Date(r.created_at).toISOString(), undoneBy: r.undone_by, undoneAt: r.undone_at ? new Date(r.undone_at).toISOString() : null,
      undoable: r.status === 'imported' && masters && r.imported > 0,
    };
  });
}

export async function importBatch(ex: Executor, orgId: number, id: number) {
  const list = await listImportBatches(ex, orgId);
  const b = list.find((x) => x.id === String(id));
  if (!b) throw notFound('That import is not in the history.');
  const row = await ex.selectFrom('import_batches').select(['errors', 'created_ids']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirstOrThrow();
  const ids = json<Record<string, number[]>>(row.created_ids, {});
  return { ...b, errors: json<ImportRowError[]>(row.errors, []), createdCounts: Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, v.length])) };
}

/** Change the note kept on an import (its Edit). */
export async function updateImportNote(trx: Trx, orgId: number, id: number, note: string | null) {
  const r = await trx.updateTable('import_batches').set({ note: note?.trim().slice(0, 500) || null }).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!Number(r.numUpdatedRows)) throw notFound('That import is not in the history.');
}

/**
 * Undo an import of masters (its Delete): the customers, vendors, items or
 * accounts it made are deleted, if nothing has used them. Refused by name
 * otherwise. The history entry stays, marked undone, with who and when.
 */
export async function undoImport(trx: Trx, orgId: number, userId: number, id: number): Promise<{ deleted: Record<string, number> }> {
  const b = await trx.selectFrom('import_batches').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!b) throw notFound('That import is not in the history.');
  if (b.status === 'undone') throw conflict('That import was undone already.');
  const ids = json<Record<string, number[]>>(b.created_ids, {});
  const tables = Object.keys(ids);
  if (!tables.length) throw badRequest('That import made nothing that can be taken away again.');
  if (!tables.every((t) => (MASTER_TABLES as readonly string[]).includes(t))) {
    throw conflict('Only an import of customers, vendors, items or accounts can be undone. Documents it posted are corrected by voiding or deleting each one, so the ledger keeps the record.');
  }
  const deleted: Record<string, number> = {};
  // Items first (they may name a vendor and accounts), then parties, then accounts.
  for (const itemId of ids.items ?? []) {
    const it = await trx.selectFrom('items').select('name').where('id', '=', itemId).where('org_id', '=', orgId).executeTakeFirst();
    if (!it) continue;
    const uses = await itemUses(trx, orgId, itemId);
    if (uses.length) throw conflict(`${it.name} is used on ${uses.join(', ')}, so this import cannot be undone. Mark it inactive instead.`);
  }
  for (const contactId of ids.contacts ?? []) {
    const c = await trx.selectFrom('contacts').select('display_name').where('id', '=', contactId).where('org_id', '=', orgId).executeTakeFirst();
    if (!c) continue;
    const { rows } = await sql<{ n: number }>`
      SELECT (SELECT COUNT(*) FROM journal_lines WHERE org_id = ${orgId} AND contact_id = ${contactId})
           + (SELECT COUNT(*) FROM invoices WHERE org_id = ${orgId} AND customer_id = ${contactId})
           + (SELECT COUNT(*) FROM bills WHERE org_id = ${orgId} AND vendor_id = ${contactId})
           + (SELECT COUNT(*) FROM payments WHERE org_id = ${orgId} AND contact_id = ${contactId})
           + (SELECT COUNT(*) FROM items WHERE org_id = ${orgId} AND preferred_vendor_id = ${contactId} AND id NOT IN (${sql.join([0, ...(ids.items ?? [])])})) AS n`.execute(trx);
    if (Number(rows[0]?.n ?? 0) > 0) throw conflict(`${c.display_name} has documents or entries in the books, so this import cannot be undone. Mark it inactive instead.`);
  }
  for (const accountId of ids.accounts ?? []) {
    const a = await trx.selectFrom('accounts').select(['code', 'name']).where('id', '=', accountId).where('org_id', '=', orgId).executeTakeFirst();
    if (!a) continue;
    const used = await trx.selectFrom('journal_lines').select('id').where('org_id', '=', orgId).where('account_id', '=', accountId).limit(1).executeTakeFirst();
    if (used) throw conflict(`Account ${a.code} ${a.name} has entries, so this import cannot be undone.`);
  }
  try {
    if (ids.items?.length) {
      await trx.deleteFrom('items').where('org_id', '=', orgId).where('id', 'in', ids.items).execute();
      deleted.items = ids.items.length;
    }
    if (ids.contacts?.length) {
      await trx.deleteFrom('contact_persons').where('org_id', '=', orgId).where('contact_id', 'in', ids.contacts).execute();
      await trx.deleteFrom('contact_addresses').where('org_id', '=', orgId).where('contact_id', 'in', ids.contacts).execute();
      await trx.deleteFrom('contacts').where('org_id', '=', orgId).where('id', 'in', ids.contacts).execute();
      deleted.contacts = ids.contacts.length;
    }
    if (ids.accounts?.length) {
      await trx.deleteFrom('accounts').where('org_id', '=', orgId).where('id', 'in', ids.accounts).execute();
      deleted.accounts = ids.accounts.length;
    }
  } catch (e) {
    if ((e as { code?: string }).code === 'ER_ROW_IS_REFERENCED_2') {
      throw conflict('Something this import made is still used by another record, so it cannot be undone. Mark those records inactive instead.');
    }
    throw e;
  }
  await trx.updateTable('import_batches').set({ status: 'undone', undone_by_user_id: userId, undone_at: new Date() }).where('id', '=', id).execute();
  return { deleted };
}
