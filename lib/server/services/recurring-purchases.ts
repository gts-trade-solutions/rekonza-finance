import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Edit and Delete on a recurring bill or expense profile, as Zoho Books has
// them on its recurring bills and expenses.
//
// A profile is a template, not a document: it posts nothing itself. Editing it
// changes what its next runs raise; the bills and expenses it has raised are
// documents in their own right and stay as they are (each has its own Edit and
// Delete). Deleting it stops it; what it raised stays too, no longer linked.
// ─────────────────────────────────────────────────────────────────────────────

import type { Trx } from '../db';
import { badRequest, notFound } from '../http';
import { recurringPurchaseValues, type RecurringPurchaseBodyInput } from '../recurring-purchase-input';

const ymd = (d: unknown) => String(d instanceof Date ? d.toISOString() : d).slice(0, 10);

/**
 * Edit a profile. Its kind stays (a bill profile does not become an expense).
 * One that has never run starts from its new first date; one that has keeps
 * its next date, unless the new first date is later.
 */
export async function updateRecurringPurchase(trx: Trx, orgId: number, id: number, input: RecurringPurchaseBodyInput) {
  const p = await trx.selectFrom('recurring_purchases').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!p) throw notFound('That profile does not exist.');
  if (input.kind !== p.kind) throw badRequest(`This is a recurring ${p.kind}; it stays one. Make a new profile for a recurring ${input.kind}.`);
  const values = await recurringPurchaseValues(trx, orgId, input);
  const ran = !!p.last_generated_at;
  const next = !ran || input.startDate > ymd(p.next_run) ? input.startDate : ymd(p.next_run);
  await trx.updateTable('recurring_purchases').set({ ...values, next_run: next, last_error: null }).where('id', '=', id).execute();
  return { name: input.name, nextRun: next, before: { ...p, template: typeof p.template === 'string' ? JSON.parse(p.template) : p.template } };
}

/** Delete a profile: it stops; the bills and expenses it raised stay, unlinked from it. */
export async function deleteRecurringPurchase(trx: Trx, orgId: number, id: number) {
  const p = await trx.selectFrom('recurring_purchases').select(['id', 'profile_name', 'kind']).where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!p) throw notFound('That profile does not exist.');
  const bills = await trx.updateTable('bills').set({ recurring_id: null }).where('org_id', '=', orgId).where('recurring_id', '=', id).executeTakeFirst();
  const expenses = await trx.updateTable('expenses').set({ recurring_id: null }).where('org_id', '=', orgId).where('recurring_id', '=', id).executeTakeFirst();
  await trx.deleteFrom('recurring_purchases').where('id', '=', id).where('org_id', '=', orgId).execute();
  return { name: p.profile_name, kind: p.kind, raised: Number(bills.numUpdatedRows ?? 0) + Number(expenses.numUpdatedRows ?? 0) };
}
