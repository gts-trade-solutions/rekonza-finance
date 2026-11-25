import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Delete for the lists people make in Settings (the client, 2026-11-25:
// "wherever we need edit and delete you should give"), as Zoho deletes them:
// a record nobody has used goes; one in use is refused with the way out the
// app already has — switch it off, mark it inactive — so what was recorded
// under it still reads.
//
//   users          refused for yourself, for the last active admin, and for
//                  anyone who has changed anything in the book (the audit
//                  trail names them, and so do their entries): switch them
//                  off instead, which signs them out everywhere.
//   custom fields  refused once a record holds a value in it: switch it off.
//   reporting tags refused once a document carries one of its values.
//   divisions      refused once an entry or document is booked to it.
//   voucher types  refused once a document was numbered in its series.
//   workflow rules go, with the record of what they did.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Trx } from '../db';
import { conflict, forbidden, notFound } from '../http';

const count = (r: { n: string | number } | undefined) => Number(r?.n ?? 0);

/** A foreign key refusing the delete: something else still names the row. */
const referenced = (e: unknown) => (e as { code?: string }).code === 'ER_ROW_IS_REFERENCED_2';

export async function deleteUser(trx: Trx, orgId: number, actorUserId: number, id: number) {
  const u = await trx.selectFrom('users').select(['id', 'name', 'email', 'role', 'is_active']).where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!u) throw notFound('That user was not found.');
  if (u.id === actorUserId) throw forbidden('You cannot delete yourself. Ask another admin.');
  if (u.role === 'admin') {
    const others = count(await trx.selectFrom('users').select(sql<string>`COUNT(*)`.as('n'))
      .where('org_id', '=', orgId).where('role', '=', 'admin').where('is_active', '=', 1).where('id', '<>', id).executeTakeFirst());
    if (!others) throw conflict(`${u.name} is the only active admin, so they cannot be deleted. Make someone else an admin first.`);
  }
  // Signing in and downloading change nothing; anything else is in the books under their name.
  const acted = count(await trx.selectFrom('audit_log').select(sql<string>`COUNT(*)`.as('n'))
    .where('org_id', '=', orgId).where('actor_user_id', '=', id).where('action', 'not in', ['login', 'export']).executeTakeFirst());
  const cannot = `${u.name} has made entries in this book, and the audit trail and those entries name them, so they cannot be deleted. Switch them off instead: they are signed out everywhere and cannot sign in.`;
  if (acted) throw conflict(cannot);
  try {
    // Sessions, sign-in codes, password history, notifications and branch access go by their keys.
    await trx.deleteFrom('users').where('id', '=', id).where('org_id', '=', orgId).execute();
  } catch (e) {
    if (referenced(e)) throw conflict(cannot);
    throw e;
  }
  return { name: u.name, email: u.email };
}

export async function deleteCustomField(trx: Trx, orgId: number, id: number) {
  const f = await trx.selectFrom('custom_fields').select(['id', 'label', 'entity']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!f) throw notFound('That field does not exist.');
  const used = count(await trx.selectFrom('custom_field_values').select(sql<string>`COUNT(*)`.as('n'))
    .where('field_id', '=', id).where('value', 'is not', null).where('value', '<>', '').executeTakeFirst());
  if (used) {
    throw conflict(`${f.label} holds a value on ${used} record(s), so it cannot be deleted. Mark it as inactive instead (switch off "In use"): it leaves the forms, and what was recorded stays readable.`);
  }
  await trx.deleteFrom('custom_fields').where('id', '=', id).execute();
  return { label: f.label };
}

export async function deleteReportingTag(trx: Trx, orgId: number, id: number) {
  const t = await trx.selectFrom('reporting_tags').select(['id', 'name']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!t) throw notFound('That tag does not exist.');
  const used = count(await trx.selectFrom('reporting_tag_links as l').innerJoin('reporting_tag_options as o', 'o.id', 'l.option_id')
    .select(sql<string>`COUNT(*)`.as('n')).where('o.tag_id', '=', id).executeTakeFirst());
  if (used) {
    throw conflict(`${t.name} is on ${used} document(s) or record(s), and the profit by reporting tag is cut by it, so it cannot be deleted. Mark it as inactive instead: it leaves the forms, and the documents keep it.`);
  }
  await trx.deleteFrom('reporting_tag_options').where('tag_id', '=', id).execute();
  await trx.deleteFrom('reporting_tags').where('id', '=', id).execute();
  return { name: t.name };
}

/** A division (a cost centre of category Division) nothing was booked to. */
export async function deleteCostCentre(trx: Trx, orgId: number, id: number) {
  const c = await trx.selectFrom('cost_centres').select(['id', 'code', 'name']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!c) throw notFound('That cost centre was not found.');
  const uses = await Promise.all((['journal_lines', 'invoices', 'bills', 'expenses'] as const).map(async (table) =>
    count(await trx.selectFrom(table).select(sql<string>`COUNT(*)`.as('n')).where('cost_centre_id', '=', id).executeTakeFirst())));
  const n = uses.reduce((a, b) => a + b, 0);
  if (n) {
    throw conflict(`${c.name} has ${n} entr${n === 1 ? 'y or document' : 'ies or documents'} booked to it, so it cannot be deleted: the profit by division reads them. Mark it as inactive instead.`);
  }
  await trx.deleteFrom('cost_centres').where('id', '=', id).execute();
  return { name: c.name, code: c.code };
}

export async function deleteVoucherType(trx: Trx, orgId: number, id: number) {
  const v = await trx.selectFrom('voucher_types').select(['id', 'name', 'doc_type', 'code']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!v) throw notFound('That voucher type does not exist.');
  const onInvoices = count(await trx.selectFrom('invoices').select(sql<string>`COUNT(*)`.as('n')).where('voucher_type_id', '=', id).executeTakeFirst());
  // Its own series: a number taken from it is a document issued under it.
  const numbered = count(await trx.selectFrom('number_series').select(sql<string>`COUNT(*)`.as('n'))
    .where('org_id', '=', orgId).where('doc_type', '=', `${v.doc_type}:${v.code}`).where('next_number', '>', 1).executeTakeFirst());
  if (onInvoices || numbered) {
    throw conflict(`Documents have been numbered as ${v.name}, so it cannot be deleted: its series has to stay unbroken. Mark it as inactive instead.`);
  }
  await trx.deleteFrom('number_series').where('org_id', '=', orgId).where('doc_type', '=', `${v.doc_type}:${v.code}`).execute();
  await trx.deleteFrom('voucher_types').where('id', '=', id).execute();
  return { name: v.name };
}

/** A workflow rule goes with the record of what it ran. */
export async function deleteWorkflowRule(trx: Trx, orgId: number, id: number) {
  const r = await trx.selectFrom('workflow_rules').select(['id', 'name']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!r) throw notFound('That rule does not exist.');
  await trx.deleteFrom('workflow_runs').where('rule_id', '=', id).execute();
  await trx.deleteFrom('workflow_rules').where('id', '=', id).execute();
  return { name: r.name };
}
