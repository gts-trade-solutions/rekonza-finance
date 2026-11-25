import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Edit and Delete on what the accountant keeps, wherever the client looked for
// them (2026-11-25): the chart of accounts, budgets, cost centres, recurring
// journal profiles, exchange rates and restatements, balance confirmations,
// fixed assets and their classes, and the business documents library.
//
// Two rules run through all of it, the same ones the documents follow
// (doc-delete.ts):
//
// - A master that is in use is never deleted: an account with postings, a
//   cost centre named on an invoice, a class that holds assets. The refusal
//   says so and offers what Zoho offers instead, Mark as inactive (code
//   'in_use', so the screen can put that button beside the message). Deleting
//   it would leave history pointing at nothing.
// - What posted is never erased. A fixed asset or a restatement is deleted by
//   reversing what it posted, on its own date, so the period nets to nothing;
//   the journal keeps both entries and deleted_documents keeps the record as
//   it stood, for the auditor.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { ApiError, badRequest, conflict, notFound } from '../http';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { postEntry, reverseEntry } from '../ledger/posting';
import { plain, recordDeletion, unlinkDocument } from './doc-delete';

/** Refused because something rests on it; the screen offers Mark as inactive instead. */
export const inUse = (message: string) => new ApiError(409, message, 'in_use');

const isReferenced = (e: unknown) => (e as { code?: string })?.code === 'ER_ROW_IS_REFERENCED_2';

// ── Chart of accounts ───────────────────────────────────────────────────────

/**
 * Delete an account nobody has used. One with postings, sub-accounts, or a
 * document, item, bank account or budget naming it is refused, and the person
 * is pointed at Mark as inactive, which hides it from pickers and leaves every
 * report as it was.
 */
export async function deleteAccount(trx: Trx, orgId: number, id: number): Promise<{ code: string; name: string }> {
  const a = await trx.selectFrom('accounts').select(['id', 'code', 'name', 'is_system'])
    .where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!a) throw notFound('That account does not exist.');
  if (a.is_system) {
    throw conflict(`${a.code} ${a.name} is a system account: the app posts to it by its code (receivables, GST, TDS and the like), so it cannot be deleted. It can be renamed.`);
  }
  const { rows } = await sql<{ posted: number; kids: number }>`
    SELECT (SELECT COUNT(*) FROM journal_lines WHERE org_id = ${orgId} AND account_id = ${id}) AS posted,
           (SELECT COUNT(*) FROM accounts WHERE org_id = ${orgId} AND parent_id = ${id}) AS kids`.execute(trx);
  const lines = Number(rows[0]?.posted ?? 0);
  if (lines > 0) {
    throw inUse(`${a.code} ${a.name} has ${lines} posting${lines === 1 ? '' : 's'} against it, so it cannot be deleted: those entries would point at nothing. Mark it as inactive instead; it leaves the pickers and every report stays as it is.`);
  }
  if (Number(rows[0]?.kids ?? 0) > 0) {
    throw conflict(`${a.code} ${a.name} has accounts grouped under it. Move them to another group, or delete them, first.`);
  }
  try {
    await trx.deleteFrom('accounts').where('id', '=', id).where('org_id', '=', orgId).execute();
  } catch (e) {
    if (isReferenced(e)) {
      throw inUse(`${a.code} ${a.name} is named on an item, a bank account, a budget, a rule or a document, so it cannot be deleted. Mark it as inactive instead.`);
    }
    throw e;
  }
  return { code: a.code, name: a.name };
}

// ── Budgets ─────────────────────────────────────────────────────────────────

/** One account's figure for a year, changed: the amount and the note. */
export async function setBudgetLine(
  trx: Trx, orgId: number, userId: number | null, input: { fy: string; accountId: number; amountPaise: Paise; notes?: string | null },
) {
  if (!/^\d{4}-\d{2}$/.test(input.fy)) throw badRequest('Give the financial year as 2026-27.');
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) throw badRequest('A budget is an amount above zero. To remove the line, delete it.');
  const a = await trx.selectFrom('accounts').select(['id', 'code', 'name', 'type']).where('id', '=', input.accountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!a) throw notFound('That account does not exist.');
  if (a.type !== 'income' && a.type !== 'expense') throw badRequest('A budget is set on an income or expense account.');
  await trx.insertInto('budgets').values({
    org_id: orgId, branch_id: 0, account_id: a.id, fy_label: input.fy, amount: toSqlFromPaise(input.amountPaise),
    notes: input.notes?.trim() || null, created_by_user_id: userId,
  }).onDuplicateKeyUpdate({ amount: toSqlFromPaise(input.amountPaise), notes: input.notes?.trim() || null }).execute();
  return { code: a.code, name: a.name };
}

/** A budget line removed: the plan only, nothing in the ledger moves. */
export async function deleteBudgetLine(trx: Trx, orgId: number, input: { fy: string; accountId: number }) {
  const row = await trx.selectFrom('budgets as b').innerJoin('accounts as a', 'a.id', 'b.account_id')
    .select(['b.id', 'b.amount', 'a.code', 'a.name'])
    .where('b.org_id', '=', orgId).where('b.fy_label', '=', input.fy).where('b.account_id', '=', input.accountId).execute();
  if (!row.length) throw notFound(`There is no budget on that account for FY ${input.fy}.`);
  await trx.deleteFrom('budgets').where('org_id', '=', orgId).where('fy_label', '=', input.fy).where('account_id', '=', input.accountId).execute();
  return { code: row[0].code, name: row[0].name, amountPaise: row.reduce((t, r) => t + toPaiseFromSql(r.amount), 0) };
}

// ── Cost centres ────────────────────────────────────────────────────────────

/**
 * Delete a cost centre named on nothing. Once an invoice, bill, expense or
 * ledger line carries it, the profit and loss by centre needs it; retire it
 * instead (switch it out of use) and the forms stop offering it.
 */
export async function deleteCostCentre(trx: Trx, orgId: number, id: number): Promise<{ code: string; name: string }> {
  const c = await trx.selectFrom('cost_centres').select(['id', 'code', 'name']).where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!c) throw notFound('That cost centre was not found.');
  const { rows } = await sql<{ n: number }>`
    SELECT (SELECT COUNT(*) FROM journal_lines WHERE org_id = ${orgId} AND cost_centre_id = ${id})
         + (SELECT COUNT(*) FROM invoices WHERE org_id = ${orgId} AND cost_centre_id = ${id})
         + (SELECT COUNT(*) FROM bills WHERE org_id = ${orgId} AND cost_centre_id = ${id})
         + (SELECT COUNT(*) FROM expenses WHERE org_id = ${orgId} AND cost_centre_id = ${id}) AS n`.execute(trx);
  const n = Number(rows[0]?.n ?? 0);
  if (n > 0) {
    throw inUse(`${c.code} ${c.name} is on ${n} posting${n === 1 ? '' : 's'} or document${n === 1 ? '' : 's'}, so it cannot be deleted: the profit and loss by cost centre counts them. Retire it instead (switch it out of use); the forms stop offering it.`);
  }
  await trx.deleteFrom('cost_centres').where('id', '=', id).where('org_id', '=', orgId).execute();
  return { code: c.code, name: c.name };
}

// ── Recurring journals ──────────────────────────────────────────────────────

export interface RecurringJournalInput {
  name: string;
  frequency: 'monthly' | 'quarterly' | 'yearly';
  nextRun: string;
  endDate?: string | null;
  debitAccountId: number;
  creditAccountId: number;
  amountPaise: Paise;
  memo?: string | null;
  autoRun?: boolean;
}

/**
 * Change a profile. It is a template, not a posting: what it posted already
 * stays as it is, and the change applies from its next run.
 */
export async function updateRecurringJournal(trx: Trx, orgId: number, id: number, input: RecurringJournalInput) {
  const p = await trx.selectFrom('recurring_journals').select(['id', 'name']).where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!p) throw notFound('That profile does not exist.');
  if (!input.name.trim()) throw badRequest('Give the profile a name.');
  if (input.debitAccountId === input.creditAccountId) throw badRequest('The debit and credit sides must be different accounts, or nothing moves.');
  if (!(input.amountPaise > 0)) throw badRequest('An entry needs an amount above zero.');
  if (input.endDate && input.endDate < input.nextRun) throw badRequest('It cannot end before its next run.');
  const found = await trx.selectFrom('accounts').select('id').where('org_id', '=', orgId)
    .where('id', 'in', [input.debitAccountId, input.creditAccountId]).execute();
  if (found.length !== 2) throw badRequest('One of those accounts does not exist.');
  await trx.updateTable('recurring_journals').set({
    name: input.name.trim(), frequency: input.frequency, next_run: input.nextRun, end_date: input.endDate ?? null,
    debit_account_id: input.debitAccountId, credit_account_id: input.creditAccountId, amount: toSqlFromPaise(input.amountPaise),
    memo: input.memo?.trim() || null, ...(input.autoRun === undefined ? {} : { auto_run: input.autoRun ? 1 : 0 }), last_error: null,
  }).where('id', '=', id).execute();
  return { before: p.name };
}

/** Delete a profile. The entries it posted are real and stay. */
export async function deleteRecurringJournal(trx: Trx, orgId: number, id: number) {
  const p = await trx.selectFrom('recurring_journals').select(['id', 'name']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!p) throw notFound('That profile does not exist.');
  await trx.deleteFrom('recurring_journals').where('id', '=', id).where('org_id', '=', orgId).execute();
  return { name: p.name };
}

// ── Balance confirmations ───────────────────────────────────────────────────

/**
 * Change the reply recorded against a confirmation: their figure and the
 * note. Clearing their figure puts it back to awaited. Our figure was fixed
 * when it was asked for and does not move.
 */
export async function updateConfirmation(trx: Trx, orgId: number, id: number, input: { theirBalancePaise: Paise | null; notes?: string | null }) {
  const row = await trx.selectFrom('balance_confirmations').select(['id', 'our_balance']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!row) throw notFound('That confirmation does not exist.');
  if (input.theirBalancePaise !== null && !Number.isInteger(input.theirBalancePaise)) throw badRequest('Give their balance in rupees and paise.');
  const agreed = input.theirBalancePaise !== null && input.theirBalancePaise === toPaiseFromSql(row.our_balance);
  await trx.updateTable('balance_confirmations').set({
    their_balance: input.theirBalancePaise === null ? null : toSqlFromPaise(input.theirBalancePaise),
    status: input.theirBalancePaise === null ? 'requested' : agreed ? 'agreed' : 'disputed',
    responded_at: input.theirBalancePaise === null ? null : new Date(),
    notes: input.notes?.trim() || null,
  }).where('id', '=', id).execute();
  return { agreed, status: input.theirBalancePaise === null ? 'requested' : agreed ? 'agreed' : 'disputed' };
}

/** Delete a confirmation asked for by mistake (it posts nothing). */
export async function deleteConfirmation(trx: Trx, orgId: number, id: number) {
  const row = await trx.selectFrom('balance_confirmations as b').innerJoin('contacts as c', 'c.id', 'b.contact_id')
    .select(['b.id', 'b.as_of', 'c.display_name']).where('b.id', '=', id).where('b.org_id', '=', orgId).executeTakeFirst();
  if (!row) throw notFound('That confirmation does not exist.');
  await trx.deleteFrom('balance_confirmations').where('id', '=', id).where('org_id', '=', orgId).execute();
  return { party: row.display_name, asOf: String(row.as_of).slice(0, 10) };
}

// ── Exchange rates and restatements ─────────────────────────────────────────

/**
 * Change a rate typed (or fetched) for a day. Documents keep the rate they
 * were booked at, so nothing already posted moves; the next restatement and
 * the next document in that currency use the new one.
 */
export async function editRate(trx: Trx, orgId: number, id: number, input: { date: string; rate: number }) {
  if (!(input.rate > 0)) throw badRequest('A rate is rupees for one unit, above zero.');
  const r = await trx.selectFrom('exchange_rates').select(['id', 'currency', 'rate_date']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!r) throw notFound('That rate was not found.');
  if (input.date !== String(r.rate_date).slice(0, 10)) {
    const clash = await trx.selectFrom('exchange_rates').select('id').where('org_id', '=', orgId).where('currency', '=', r.currency)
      .where('rate_date', '=', input.date).where('id', '!=', id).executeTakeFirst();
    if (clash) throw conflict(`There is already a ${r.currency} rate for ${input.date}. Edit that one instead.`);
  }
  await trx.updateTable('exchange_rates').set({ rate_date: input.date, rate: String(input.rate), source: 'Typed' }).where('id', '=', id).execute();
  return { currency: r.currency };
}

export async function deleteRate(trx: Trx, orgId: number, id: number) {
  const r = await trx.selectFrom('exchange_rates').select(['id', 'currency', 'rate_date', 'rate']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!r) throw notFound('That rate was not found.');
  await trx.deleteFrom('exchange_rates').where('id', '=', id).execute();
  return { currency: r.currency, date: String(r.rate_date).slice(0, 10), rate: Number(r.rate) };
}

export interface RestatementRow { entryId: string; entryNo: number; date: string; amountPaise: Paise; memo: string | null; reversedOn: string | null }

/** Zoho's Currency Adjustments list: each restatement still standing. */
export async function listRestatements(ex: Executor, orgId: number): Promise<RestatementRow[]> {
  const { rows } = await sql<{ id: number; entry_no: number; entry_date: string | Date; total_debit: string; memo: string | null; reversed_on: string | Date | null }>`
    SELECT e.id, e.entry_no, e.entry_date, e.total_debit, e.memo,
           (SELECT MIN(r.entry_date) FROM journal_entries r WHERE r.org_id = e.org_id AND r.reversal_of_entry_id = e.id) AS reversed_on
      FROM journal_entries e
     WHERE e.org_id = ${orgId} AND e.source_type = 'fx_revaluation' AND e.reversal_of_entry_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM deleted_documents d WHERE d.org_id = e.org_id AND d.doc_type = 'fx_restatement' AND d.doc_id = e.id)
     ORDER BY e.entry_date DESC, e.id DESC LIMIT 100`.execute(ex);
  const day = (v: string | Date | null) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : null);
  return rows.map((r) => ({ entryId: String(r.id), entryNo: r.entry_no, date: day(r.entry_date)!, amountPaise: toPaiseFromSql(r.total_debit), memo: r.memo, reversedOn: day(r.reversed_on) }));
}

/**
 * Delete a restatement. It was posted at a period end and reversed itself the
 * next day, so both halves are undone on their own dates: the restatement by
 * an entry the other way on its date, its reversal by a reversal on the day
 * after. Every day then nets to what it was before, and the date can be
 * restated again.
 */
export async function deleteRestatement(trx: Trx, orgId: number, userId: number | null, entryId: number, reason?: string | null) {
  const e = await trx.selectFrom('journal_entries').selectAll().where('id', '=', entryId).where('org_id', '=', orgId).executeTakeFirst();
  if (!e || e.source_type !== 'fx_revaluation' || e.reversal_of_entry_id) throw notFound('That restatement was not found.');
  const gone = await trx.selectFrom('deleted_documents').select('id').where('org_id', '=', orgId)
    .where('doc_type', '=', 'fx_restatement').where('doc_id', '=', entryId).executeTakeFirst();
  if (gone) throw conflict(`The restatement #${e.entry_no} is already deleted.`);
  const date = String(e.entry_date).slice(0, 10);
  const lines = await trx.selectFrom('journal_lines').select(['account_id', 'debit', 'credit', 'description', 'contact_id', 'cost_centre_id'])
    .where('entry_id', '=', entryId).orderBy('line_no').execute();
  const undo = await postEntry(trx, {
    orgId, branchId: e.branch_id, date, userId, module: 'accountant', sourceType: 'fx_revaluation', sourceId: null,
    reversalOfEntryId: entryId, memo: `Restatement #${e.entry_no} of ${date} deleted`,
    lines: lines.map((l) => ({
      accountId: l.account_id, debit: toPaiseFromSql(l.credit), credit: toPaiseFromSql(l.debit),
      contactId: l.contact_id, description: l.description, costCentreId: l.cost_centre_id,
    })),
  });
  // Its next-day reversal (the first entry that reverses it), undone too.
  const nextDay = await trx.selectFrom('journal_entries').select(['id', 'entry_no']).where('org_id', '=', orgId)
    .where('reversal_of_entry_id', '=', entryId).where('id', '!=', undo.id).orderBy('id').executeTakeFirst();
  let second: number | null = null;
  if (nextDay) {
    second = (await reverseEntry(trx, orgId, nextDay.id, { memo: `Restatement #${e.entry_no} deleted: its reversal #${nextDay.entry_no} undone`, userId, module: 'accountant' })).id;
  }
  await recordDeletion(trx, {
    orgId, userId, docType: 'fx_restatement', docId: entryId, number: `#${e.entry_no}`, date,
    totalPaise: toPaiseFromSql(e.total_debit), branchId: e.branch_id, journalEntryId: entryId, reversalEntryId: undo.id,
    reason, snapshot: { entry: plain(e), lines: lines.map(plain), undoEntryId: undo.id, reversalUndoneBy: second },
  });
  return { entryNo: e.entry_no, date, undoEntryNo: undo.entryNo };
}

// ── Fixed assets ────────────────────────────────────────────────────────────

/**
 * Delete an asset entered by mistake. Only while nothing has been worked out
 * from it: once depreciation is posted on it, or it is sold or scrapped, the
 * register and the Schedule II working rest on it — undo the run, or keep it.
 * What adding it posted (its cost, its capitalisation) is reversed on its own
 * date; its costs and verifications go with it; a bill it came from is left
 * as it was.
 */
export async function deleteAsset(trx: Trx, orgId: number, userId: number | null, id: number, reason?: string | null) {
  const a = await trx.selectFrom('fixed_assets').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!a) throw notFound('That asset is not in the register.');
  if (a.status === 'disposed') throw conflict(`${a.name} (${a.tag_no}) has been sold or scrapped. Its disposal is history; it stays in the register.`);
  const dep = await trx.selectFrom('depreciation_lines').select(sql<string>`COUNT(*)`.as('n'))
    .where('asset_id', '=', id).where('reversed', '=', 0).executeTakeFirst();
  if (Number(dep?.n ?? 0) > 0) {
    throw conflict(`Depreciation has been posted on ${a.name} (${a.tag_no}). Undo those depreciation runs first (Depreciation tab), then delete it.`);
  }
  const costs = await trx.selectFrom('asset_costs').selectAll().where('asset_id', '=', id).orderBy('id').execute();
  const verifications = await trx.selectFrom('asset_verifications').selectAll().where('asset_id', '=', id).execute();
  // What it posted: each cost's entry, and its putting to use.
  const capitalised = await trx.selectFrom('journal_entries').select('id').where('org_id', '=', orgId)
    .where('source_type', '=', 'asset_capitalisation').where('source_id', '=', id).where('reversal_of_entry_id', 'is', null).execute();
  const entries = [...new Set([...costs.map((c) => c.journal_entry_id).filter((x): x is number => !!x), ...capitalised.map((c) => c.id)])];
  const reversals: number[] = [];
  for (const entryId of entries) {
    const done = await trx.selectFrom('journal_entries').select('id').where('org_id', '=', orgId).where('reversal_of_entry_id', '=', entryId).executeTakeFirst();
    if (done) continue;
    reversals.push((await reverseEntry(trx, orgId, entryId, { memo: `Asset ${a.tag_no} ${a.name} deleted`, userId, module: 'accountant' })).id);
  }
  await trx.deleteFrom('depreciation_lines').where('asset_id', '=', id).execute();
  await trx.deleteFrom('asset_verifications').where('asset_id', '=', id).execute();
  await trx.deleteFrom('asset_costs').where('asset_id', '=', id).execute();
  await unlinkDocument(trx, orgId, 'fixed_asset', id);
  await trx.deleteFrom('fixed_assets').where('id', '=', id).execute();
  const cost = costs.reduce((t, c) => t + toPaiseFromSql(c.amount), 0);
  await recordDeletion(trx, {
    orgId, userId, docType: 'fixed_asset', docId: id, number: a.tag_no, date: String(a.acquired_on).slice(0, 10), totalPaise: cost,
    contactId: a.vendor_id, branchId: a.branch_id, journalEntryId: entries[0] ?? null, reversalEntryId: reversals[0] ?? null, reason,
    snapshot: { asset: plain(a), costs: costs.map(plain), verifications: verifications.map(plain), reversals },
  });
  return { tagNo: a.tag_no, name: a.name, reversed: reversals.length };
}

/** Delete a class no asset is in. */
export async function deleteAssetClass(trx: Trx, orgId: number, id: number) {
  const c = await trx.selectFrom('asset_classes').select(['id', 'name']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!c) throw notFound('That class does not exist.');
  const used = await trx.selectFrom('fixed_assets').select(sql<string>`COUNT(*)`.as('n')).where('org_id', '=', orgId).where('class_id', '=', id).executeTakeFirst();
  const n = Number(used?.n ?? 0);
  if (n > 0) throw conflict(`${c.name} holds ${n} asset${n === 1 ? '' : 's'} (disposed ones included), so it cannot be deleted. Edit it instead.`);
  await trx.deleteFrom('asset_classes').where('id', '=', id).execute();
  return { name: c.name };
}

// ── Business documents ──────────────────────────────────────────────────────

/**
 * Delete a contract, licence or certificate from the library. Its files are
 * not lost: they go back to the Documents inbox, unattached, as a file
 * somebody uploaded always does when what it was on is deleted.
 */
export async function deleteBusinessDocument(trx: Trx, orgId: number, userId: number | null, id: number, reason?: string | null) {
  const d = await trx.selectFrom('documents').selectAll().where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!d) throw notFound('That document was not found.');
  const files = await trx.selectFrom('files').select(sql<string>`COUNT(*)`.as('n'))
    .where('org_id', '=', orgId).where('attached_to_type', '=', 'document').where('attached_to_id', '=', id).executeTakeFirst();
  await unlinkDocument(trx, orgId, 'document', id);
  await trx.deleteFrom('documents').where('id', '=', id).execute();
  await recordDeletion(trx, {
    orgId, userId, docType: 'business_document', docId: id, number: d.reference, date: d.issued_on ? String(d.issued_on).slice(0, 10) : null,
    contactId: d.contact_id, reason, snapshot: plain(d),
  });
  return { title: d.title, filesKept: Number(files?.n ?? 0) };
}
