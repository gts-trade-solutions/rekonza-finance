import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Merging two customers, or two vendors, as Zoho Books does: the same party
// entered twice becomes one. Every invoice, bill, payment, order, credit,
// ledger line, contact person, address, file and comment of the one merged
// away moves to the one kept; the one merged away is archived, pointing at
// where it went (contacts.merged_into_id), and its portal links stop working.
//
// Which tables hold a contact is read from the database's own foreign keys,
// plus the few columns that hold one without a key, so a table added later is
// not left pointing at a contact nobody can find.
//
// GST decides what may be merged. Two different GSTINs are two businesses in
// the returns. A party with no GSTIN merged into one with a GSTIN would turn
// its past invoices into B2B supplies to that GSTIN when a return is worked
// out again, so that is allowed only while it has no invoices, notes or bills.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import { badRequest, conflict, notFound } from '../http';
import { revokePortalLinks } from './portal';

/** Columns that hold a contact without a foreign key to say so. */
const UNKEYED: ReadonlyArray<readonly [string, string]> = [
  ['documents', 'contact_id'], ['expenses', 'billable_customer_id'], ['journal_allocations', 'contact_id'],
  ['journal_lines', 'contact_id'], ['portal_activity', 'contact_id'],
];

/** Things that point at any record by type and id, where the type is a contact. */
const BY_TYPE: ReadonlyArray<readonly [string, string, string]> = [
  ['files', 'attached_to_type', 'attached_to_id'], ['comments', 'target_type', 'target_id'],
];

async function contactColumns(ex: Executor): Promise<{ table: string; column: string; hasOrg: boolean }[]> {
  const { rows } = await sql<{ t: string; c: string; o: number }>`
    SELECT k.TABLE_NAME AS t, k.COLUMN_NAME AS c,
           (SELECT COUNT(*) FROM information_schema.COLUMNS x WHERE x.TABLE_SCHEMA = k.TABLE_SCHEMA AND x.TABLE_NAME = k.TABLE_NAME AND x.COLUMN_NAME = 'org_id') AS o
      FROM information_schema.KEY_COLUMN_USAGE k
     WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME = 'contacts' AND k.REFERENCED_COLUMN_NAME = 'id'`.execute(ex);
  const seen = new Set(rows.map((r) => `${r.t}.${r.c}`));
  return [
    ...rows.map((r) => ({ table: r.t, column: r.c, hasOrg: Number(r.o) > 0 })),
    ...UNKEYED.filter(([t, c]) => !seen.has(`${t}.${c}`)).map(([table, column]) => ({ table, column, hasOrg: true })),
  ];
}

interface Pair {
  from: { id: number; display_name: string; kind: string; gstin: string | null; is_archived: number; erased_at: unknown; merged_into_id: number | null };
  into: { id: number; display_name: string; kind: string; gstin: string | null; is_archived: number; erased_at: unknown; merged_into_id: number | null };
}

const gstinOf = (g: string | null) => (g ?? '').trim().toUpperCase();

async function pair(ex: Executor, orgId: number, fromId: number, intoId: number, lock: boolean): Promise<Pair> {
  if (fromId === intoId) throw badRequest('Choose a different contact to merge into.');
  let q = ex.selectFrom('contacts').select(['id', 'display_name', 'kind', 'gstin', 'is_archived', 'erased_at', 'merged_into_id'])
    .where('org_id', '=', orgId).where('id', 'in', [fromId, intoId]);
  if (lock) q = q.forUpdate();
  const rows = await q.execute();
  const from = rows.find((r) => r.id === fromId);
  const into = rows.find((r) => r.id === intoId);
  if (!from || !into) throw notFound('That contact does not exist.');
  return { from, into };
}

/** Why these two cannot be merged, or null. */
async function blocker(ex: Executor, orgId: number, { from, into }: Pair): Promise<string | null> {
  if (from.merged_into_id) return `${from.display_name} was already merged into another contact.`;
  if (into.merged_into_id) return `${into.display_name} was merged into another contact; merge into that one.`;
  if (from.erased_at || into.erased_at) return 'A contact whose personal data was erased cannot be merged.';
  if (into.is_archived) return `${into.display_name} is archived. Restore it first, or merge the other way.`;
  // A vendor's bills cannot land on a customer-only contact, nor a customer's invoices on a vendor.
  if (from.kind !== into.kind && into.kind !== 'both') {
    return `${from.display_name} is a ${from.kind === 'both' ? 'customer and vendor' : from.kind}; ${into.display_name} is a ${into.kind} only.`;
  }
  const a = gstinOf(from.gstin);
  const b = gstinOf(into.gstin);
  if (a && b && a !== b) return `They have different GSTINs (${a} and ${b}): in GST returns they are two businesses.`;
  if (a !== b) {
    const { rows } = await sql<{ n: number }>`
      SELECT (SELECT COUNT(*) FROM invoices WHERE org_id = ${orgId} AND customer_id = ${from.id} AND status <> 'draft')
           + (SELECT COUNT(*) FROM credit_notes WHERE org_id = ${orgId} AND customer_id = ${from.id})
           + (SELECT COUNT(*) FROM bills WHERE org_id = ${orgId} AND vendor_id = ${from.id} AND status <> 'draft') AS n`.execute(ex);
    if (Number(rows[0]?.n ?? 0) > 0) {
      return `Only one of them has a GSTIN, and ${from.display_name} has invoices or bills: merging would change how those appear in GST returns already worked out. Give both the same GSTIN first, or keep them apart.`;
    }
  }
  return null;
}

/** What a merge would move, without moving it: for the confirmation. */
export async function mergePreview(ex: Executor, orgId: number, fromId: number, intoId: number) {
  const p = await pair(ex, orgId, fromId, intoId, false);
  const counts: Record<string, number> = {};
  for (const { table, column, hasOrg } of await contactColumns(ex)) {
    const { rows } = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql.table(table)} WHERE ${sql.ref(column)} = ${fromId} ${hasOrg ? sql`AND org_id = ${orgId}` : sql``}`.execute(ex);
    const n = Number(rows[0]?.n ?? 0);
    if (n) counts[table] = (counts[table] ?? 0) + n;
  }
  return {
    from: { id: String(p.from.id), name: p.from.display_name },
    into: { id: String(p.into.id), name: p.into.display_name },
    blocked: await blocker(ex, orgId, p),
    counts,
  };
}

/** Merge one contact into another. Returns how many rows moved, by table. */
export async function mergeContacts(trx: Trx, orgId: number, fromId: number, intoId: number) {
  const p = await pair(trx, orgId, fromId, intoId, true);
  const why = await blocker(trx, orgId, p);
  if (why) throw conflict(why);

  // Its links stop working before anything moves: nobody holding one should
  // find themselves looking at the other contact's account.
  await revokePortalLinks(trx, orgId, fromId);
  const ownDefault = await trx.selectFrom('contact_addresses').select('id')
    .where('org_id', '=', orgId).where('contact_id', '=', intoId).where('is_default', '=', 1).executeTakeFirst();

  const moved: Record<string, number> = {};
  for (const { table, column, hasOrg } of await contactColumns(trx)) {
    // IGNORE: a row the kept contact already has its own of (the same TDS certificate twice) stays where it was.
    const r = await sql`UPDATE IGNORE ${sql.table(table)} SET ${sql.ref(column)} = ${intoId} WHERE ${sql.ref(column)} = ${fromId} ${hasOrg ? sql`AND org_id = ${orgId}` : sql``}`.execute(trx);
    const n = Number(r.numAffectedRows ?? 0);
    if (n) moved[table] = (moved[table] ?? 0) + n;
  }
  for (const [table, typeCol, idCol] of BY_TYPE) {
    const r = await sql`UPDATE ${sql.table(table)} SET ${sql.ref(idCol)} = ${intoId} WHERE org_id = ${orgId} AND ${sql.ref(typeCol)} = 'contact' AND ${sql.ref(idCol)} = ${fromId}`.execute(trx);
    const n = Number(r.numAffectedRows ?? 0);
    if (n) moved[table] = (moved[table] ?? 0) + n;
  }
  // Custom fields: the kept contact's own values win; the rest come across.
  const kept = (await trx.selectFrom('custom_field_values').select('field_id').where('org_id', '=', orgId).where('entity_id', '=', intoId)
    .where('field_id', 'in', (eb) => eb.selectFrom('custom_fields').select('id').where('org_id', '=', orgId).where('entity', '=', 'contact')).execute()).map((r) => r.field_id);
  const values = trx.updateTable('custom_field_values').set({ entity_id: intoId }).where('org_id', '=', orgId).where('entity_id', '=', fromId)
    .where('field_id', 'in', (eb) => eb.selectFrom('custom_fields').select('id').where('org_id', '=', orgId).where('entity', '=', 'contact'));
  await (kept.length ? values.where('field_id', 'not in', kept) : values).execute();

  // One default delivery address is enough: the kept contact's own, if it had one.
  if (ownDefault) {
    await trx.updateTable('contact_addresses').set({ is_default: 0 })
      .where('org_id', '=', orgId).where('contact_id', '=', intoId).where('id', '<>', ownDefault.id).execute();
  }

  // What the kept contact lacks, the other one can supply: an email, a phone, a PAN, an address.
  const [src, dst] = await Promise.all([
    trx.selectFrom('contacts').selectAll().where('id', '=', fromId).executeTakeFirstOrThrow(),
    trx.selectFrom('contacts').selectAll().where('id', '=', intoId).executeTakeFirstOrThrow(),
  ]);
  const fill: Record<string, unknown> = {};
  for (const k of ['email', 'phone', 'pan', 'gstin', 'legal_name', 'billing_address', 'billing_city', 'billing_pincode', 'shipping_address', 'shipping_city', 'shipping_pincode'] as const) {
    if (!String(dst[k] ?? '').trim() && String(src[k] ?? '').trim()) fill[k] = src[k];
  }
  if (Object.keys(fill).length) await trx.updateTable('contacts').set(fill).where('id', '=', intoId).execute();

  await trx.updateTable('contacts').set({
    is_archived: 1, merged_into_id: intoId, merged_at: new Date(),
    notes: [src.notes, `Merged into ${dst.display_name} on ${new Date().toISOString().slice(0, 10)}.`].filter(Boolean).join('\n'),
  }).where('id', '=', fromId).execute();

  return { from: p.from.display_name, into: p.into.display_name, moved };
}
