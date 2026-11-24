import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Zoho Books' retainer invoice, as its form has it (recorded 2026-11-23):
// Reference#, Project Name, a DESCRIPTION | AMOUNT table of several lines,
// Customer Notes and Terms & Conditions (migration 122) — and its Edit and
// Delete.
//
// The ledger is createRetainer's, unchanged: Dr Receivable, Cr Unearned
// revenue for the whole. `description` is the lines joined and `amount` their
// sum, so every report reads a retainer exactly as before. An edit or a delete
// is refused once money rests on it (paid, or applied to an invoice); before
// that the old entry is reversed on its own date and, for an edit, posted
// again in place (doc-delete.ts), as every other document's edit is.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { badRequest, notFound } from '../http';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { postEntry } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { createRetainer } from './sales-documents';
import { recordDeletion, reverseForChange, unlinkDocument } from './doc-delete';

export interface RetainerLine { description: string; amountPaise: Paise }

export interface RetainerFormInput {
  branchId: number;
  customerId: number;
  date: string;
  reference?: string | null;
  projectId?: number | null;
  lines: RetainerLine[];
  notes?: string | null;
  terms?: string | null;
  status?: 'draft' | 'sent';
}

/** Zoho's checks on the lines, in Zoho's words; the joined description and the total. */
function checkLines(lines: RetainerLine[]): { description: string; amountPaise: Paise } {
  const kept = lines.filter((l) => l.description.trim() || l.amountPaise);
  if (!kept.length || kept.some((l) => !l.description.trim())) throw badRequest('The Description field cannot be empty.');
  if (kept.some((l) => !(l.amountPaise > 0))) throw badRequest('Enter an amount above zero on every line.');
  const description = kept.map((l) => l.description.trim()).join('; ');
  return { description: description.length > 500 ? `${description.slice(0, 497)}…` : description, amountPaise: kept.reduce((t, l) => t + l.amountPaise, 0) };
}

const linesJson = (lines: RetainerLine[]) => JSON.stringify(lines.filter((l) => l.description.trim()).map((l) => ({ description: l.description.trim(), amountPaise: l.amountPaise })));

export async function createRetainerZoho(trx: Trx, orgId: number, userId: number | null, input: RetainerFormInput) {
  const { description, amountPaise } = checkLines(input.lines);
  if (input.projectId) await checkProject(trx, orgId, input.projectId, input.customerId);
  const made = await createRetainer(trx, orgId, userId, {
    branchId: input.branchId, customerId: input.customerId, date: input.date, description, amountPaise, status: input.status ?? 'sent',
  });
  await trx.updateTable('retainer_invoices').set({
    reference: input.reference?.trim() || null, project_id: input.projectId ?? null,
    notes: input.notes?.trim() || null, terms: input.terms?.trim() || null, lines: linesJson(input.lines),
  }).where('id', '=', made.id).execute();
  return made;
}

async function checkProject(ex: Executor, orgId: number, projectId: number, customerId: number) {
  const p = await ex.selectFrom('projects').select(['id', 'customer_id']).where('id', '=', projectId).where('org_id', '=', orgId).executeTakeFirst();
  if (!p) throw notFound('That project does not exist.');
  if (p.customer_id && p.customer_id !== customerId) throw badRequest("That project is another customer's.");
}

export interface RetainerDetail {
  id: string; number: string; status: string; date: string; branchId: string;
  customerId: string; customerName: string; reference: string | null;
  projectId: string | null; projectName: string | null;
  lines: RetainerLine[]; notes: string | null; terms: string | null;
  totalPaise: Paise; paidPaise: Paise; appliedPaise: Paise; balancePaise: Paise;
  /** Paid back to the customer (Zoho's ⋯ → Refund), and what is still paid but neither applied nor refunded. */
  refundedPaise: Paise; unappliedPaise: Paise;
  refunds: { entryId: string; date: string; amountPaise: Paise; memo: string | null }[];
  journalEntryId: string | null;
  /** Edit and Delete are open until money rests on it. */
  changeable: boolean;
}

export async function retainerDetail(ex: Executor, orgId: number, id: number): Promise<RetainerDetail> {
  const r = await ex.selectFrom('retainer_invoices as r').innerJoin('contacts as c', 'c.id', 'r.customer_id')
    .leftJoin('projects as p', 'p.id', 'r.project_id')
    .select(['r.id', 'r.number', 'r.status', 'r.retainer_date', 'r.branch_id', 'r.customer_id', 'c.display_name', 'r.reference', 'r.project_id', 'p.name as project_name',
      'r.description', 'r.lines', 'r.notes', 'r.terms', 'r.amount', 'r.amount_paid', 'r.applied_amount', 'r.refunded_amount', 'r.journal_entry_id'])
    .where('r.id', '=', id).where('r.org_id', '=', orgId).executeTakeFirst();
  if (!r) throw notFound('That retainer invoice does not exist.');
  const total = toPaiseFromSql(r.amount);
  const paid = toPaiseFromSql(r.amount_paid);
  const applied = toPaiseFromSql(r.applied_amount);
  const refunded = toPaiseFromSql(r.refunded_amount);
  const refunds = await retainerRefunds(ex, orgId, id);
  const raw = typeof r.lines === 'string' ? JSON.parse(r.lines) : r.lines;
  const lines: RetainerLine[] = Array.isArray(raw) && raw.length
    ? raw.map((l: { description: string; amountPaise: number }) => ({ description: String(l.description), amountPaise: Number(l.amountPaise) }))
    : [{ description: r.description, amountPaise: total }];
  return {
    id: String(r.id), number: r.number, status: r.status, date: String(r.retainer_date).slice(0, 10), branchId: String(r.branch_id),
    customerId: String(r.customer_id), customerName: r.display_name, reference: r.reference ?? null,
    projectId: r.project_id ? String(r.project_id) : null, projectName: r.project_name ?? null,
    lines, notes: r.notes ?? null, terms: r.terms ?? null,
    totalPaise: total, paidPaise: paid, appliedPaise: applied, balancePaise: Math.max(0, total - paid),
    refundedPaise: refunded, unappliedPaise: Math.max(0, paid - applied - refunded),
    refunds: refunds.map((x) => ({ ...x, entryId: String(x.entryId) })),
    journalEntryId: r.journal_entry_id ? String(r.journal_entry_id) : null,
    changeable: r.status !== 'void' && paid === 0 && applied === 0,
  };
}

async function forChange(trx: Trx, orgId: number, id: number) {
  const r = await trx.selectFrom('retainer_invoices').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!r) throw notFound('That retainer invoice does not exist.');
  if (r.status === 'void') throw badRequest(`${r.number} is void.`);
  if (toPaiseFromSql(r.amount_paid) > 0 || toPaiseFromSql(r.applied_amount) > 0) {
    throw badRequest(`${r.number} has been paid or applied to an invoice. Take the payment off it first.`);
  }
  return r;
}

/** Zoho's Edit: the same number, the old entry reversed on its own date, posted again. */
export async function updateRetainer(trx: Trx, orgId: number, userId: number | null, id: number, input: RetainerFormInput) {
  const r = await forChange(trx, orgId, id);
  const { description, amountPaise } = checkLines(input.lines);
  if (input.projectId) await checkProject(trx, orgId, input.projectId, input.customerId);
  await reverseForChange(trx, orgId, r.journal_entry_id, { memo: `Retainer ${r.number} edited`, userId, module: 'sales' });
  const acc = await accountIds(trx, orgId);
  const entry = await postEntry(trx, {
    orgId, branchId: input.branchId, date: input.date, memo: `Retainer ${r.number} — ${description}`,
    sourceType: 'retainer', sourceId: id, userId, module: 'sales',
    lines: [
      { accountId: requireAccount(acc, CODE.AR), debit: amountPaise, contactId: input.customerId },
      { accountId: requireAccount(acc, CODE.UNEARNED), credit: amountPaise },
    ],
  });
  await trx.updateTable('retainer_invoices').set({
    branch_id: input.branchId, customer_id: input.customerId, retainer_date: input.date, description, amount: toSqlFromPaise(amountPaise),
    reference: input.reference?.trim() || null, project_id: input.projectId ?? null,
    notes: input.notes?.trim() || null, terms: input.terms?.trim() || null, lines: linesJson(input.lines),
    status: input.status ?? (r.status === 'draft' ? 'draft' : 'sent'), journal_entry_id: entry.id,
  }).where('id', '=', id).execute();
  return { id, number: r.number, totalPaise: amountPaise, journalEntryId: entry.id };
}

/** Zoho's Delete: the entry reversed, the number kept as deleted (migration 118). */
export async function deleteRetainer(trx: Trx, orgId: number, userId: number | null, id: number, reason?: string | null) {
  const r = await forChange(trx, orgId, id);
  const reversal = await reverseForChange(trx, orgId, r.journal_entry_id, { memo: `Retainer ${r.number} deleted`, userId, module: 'sales' });
  await unlinkDocument(trx, orgId, 'retainer_invoice', id);
  await recordDeletion(trx, {
    orgId, branchId: r.branch_id, docType: 'retainer', docId: id, number: r.number, date: String(r.retainer_date).slice(0, 10),
    totalPaise: toPaiseFromSql(r.amount), contactId: r.customer_id, journalEntryId: r.journal_entry_id, reversalEntryId: reversal,
    reason: reason ?? null, snapshot: r, userId,
  });
  await trx.deleteFrom('payment_allocations').where('org_id', '=', orgId).where('target_type', '=', 'retainer').where('target_id', '=', id).execute();
  await trx.deleteFrom('retainer_invoices').where('id', '=', id).execute();
  return { deleted: true as const, number: r.number };
}

// ── Refund (Zoho's ⋯ → Refund) ───────────────────────────────────────────────

/**
 * Pay back a paid retainer's money that was never applied to an invoice:
 *
 *   Dr Unearned revenue      we no longer hold it for future work
 *     Cr Bank                it has gone back to the customer
 *
 * Only what is paid and neither applied nor refunded already can go back. The
 * refund is its own journal entry (source retainer_refund), so it shows in the
 * retainer's history and can be deleted, which reverses it.
 */
export async function refundRetainer(
  trx: Trx, orgId: number, userId: number | null, id: number,
  input: { date: string; amountPaise?: Paise; bankAccountId: number; mode?: string | null; reference?: string | null },
): Promise<{ journalEntryId: number; refundedPaise: Paise; unappliedPaise: Paise }> {
  const r = await trx.selectFrom('retainer_invoices').select(['id', 'number', 'status', 'branch_id', 'customer_id', 'retainer_date', 'amount_paid', 'applied_amount', 'refunded_amount'])
    .where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!r) throw notFound('That retainer invoice does not exist.');
  if (r.status === 'void') throw badRequest(`${r.number} is void.`);
  const unapplied = toPaiseFromSql(r.amount_paid) - toPaiseFromSql(r.applied_amount) - toPaiseFromSql(r.refunded_amount);
  if (unapplied <= 0) throw badRequest(`Nothing of ${r.number} is paid and unapplied, so there is nothing to refund.`);
  const amount = input.amountPaise ?? unapplied;
  if (!(amount > 0)) throw badRequest('Enter the amount to refund.');
  if (amount > unapplied) throw badRequest(`Only ${(unapplied / 100).toFixed(2)} of ${r.number} is paid and not applied; that is the most that can be refunded.`);
  if (input.date < String(r.retainer_date).slice(0, 10)) throw badRequest('A refund cannot be dated before the retainer invoice.');
  const bank = await trx.selectFrom('bank_accounts').select(['id', 'ledger_account_id']).where('id', '=', input.bankAccountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!bank) throw notFound('Choose the account the refund is paid from.');
  const acc = await accountIds(trx, orgId);
  const entry = await postEntry(trx, {
    orgId, branchId: r.branch_id, date: input.date, userId, module: 'sales',
    memo: `Refund from retainer ${r.number}${input.mode ? ` by ${input.mode}` : ''}${input.reference ? ` — ${input.reference}` : ''}`,
    sourceType: 'retainer_refund', sourceId: r.id,
    lines: [
      { accountId: requireAccount(acc, CODE.UNEARNED), debit: amount, description: `Refund from ${r.number}`, contactId: r.customer_id },
      { accountId: bank.ledger_account_id, credit: amount },
    ],
  });
  const refunded = toPaiseFromSql(r.refunded_amount) + amount;
  await trx.updateTable('retainer_invoices').set({ refunded_amount: toSqlFromPaise(refunded) }).where('id', '=', r.id).execute();
  return { journalEntryId: entry.id, refundedPaise: amount, unappliedPaise: unapplied - amount };
}

/** The refunds paid from a retainer and still standing (not reversed). */
export async function retainerRefunds(ex: Executor, orgId: number, id: number): Promise<{ entryId: number; date: string; amountPaise: Paise; memo: string | null }[]> {
  const { rows } = await sql<{ id: number; entry_date: string; memo: string | null; amount: string }>`
    SELECT je.id, je.entry_date, je.memo, je.total_debit AS amount
      FROM journal_entries je
     WHERE je.org_id = ${orgId} AND je.source_type = 'retainer_refund' AND je.source_id = ${id}
       AND je.reversal_of_entry_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM journal_entries x WHERE x.reversal_of_entry_id = je.id)
     ORDER BY je.entry_date, je.id`.execute(ex);
  return rows.map((x) => ({ entryId: x.id, date: String((x.entry_date as unknown) instanceof Date ? (x.entry_date as unknown as Date).toISOString() : x.entry_date).slice(0, 10), amountPaise: toPaiseFromSql(x.amount), memo: x.memo }));
}

/** Delete a refund: its entry is reversed and the money is the retainer's to apply again. */
export async function deleteRetainerRefund(trx: Trx, orgId: number, userId: number | null, id: number, entryId: number): Promise<{ unappliedPaise: Paise }> {
  const refund = (await retainerRefunds(trx, orgId, id)).find((x) => x.entryId === entryId);
  if (!refund) throw notFound('That refund does not exist, or was already deleted.');
  const r = await trx.selectFrom('retainer_invoices').select(['id', 'number', 'amount_paid', 'applied_amount', 'refunded_amount']).where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
  await reverseForChange(trx, orgId, entryId, { memo: `Refund from retainer ${r.number} deleted`, userId, module: 'sales' });
  const refunded = Math.max(0, toPaiseFromSql(r.refunded_amount) - refund.amountPaise);
  await trx.updateTable('retainer_invoices').set({ refunded_amount: toSqlFromPaise(refunded) }).where('id', '=', id).execute();
  return { unappliedPaise: toPaiseFromSql(r.amount_paid) - toPaiseFromSql(r.applied_amount) - refunded };
}
