import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Reversing a voucher, as an auditor tests it.
//
// A posted entry is never edited or deleted (posting.ts): it is undone by a
// second entry with every debit and credit swapped, linked both ways — the
// reversal says "Reversal of #9", the original "Reversed by #10" — so the
// books show both what was recorded and that it was corrected. That is the
// edit log the Companies (Accounts) Rules, rule 3(1), asks for; deleting the
// original would leave no evidence it ever existed.
//
// The rules a reversal keeps:
//   · a reason, always, kept with the reversal and in the audit trail;
//   · once only: an entry already reversed, or with a reversal waiting for
//     approval, is refused;
//   · never into a locked period or a closed year (transaction locks; closing
//     a year locks every module to its last day): refused with the first date
//     that is open, so the person can reverse on that date instead;
//   · maker and checker: where a journal approval rule covers the amount, the
//     reversal waits for a second person with the rule's role, exactly as the
//     journal itself did, and whoever asked for it cannot approve it
//     (held-journals.ts);
//   · a document's entry (an invoice, a bill, a payment or receipt, a bank
//     transfer) is reversed by voiding or deleting the document, which posts
//     the reversing entry and keeps the document's record; reversing only its
//     entry would leave the document and the ledger telling different stories.
//
// The Reversed vouchers register lists every reversal pair in the books —
// journals and documents alike — with its reason and who did it.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise, RoleName } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { ApiError, badRequest, conflict, notFound } from '../http';
import { reverseJournal } from './journals';
import { recordApprovalAction, ruleFor } from './approvals';
import { dayLabel } from '../../date-range';

/** Entries that stand on their own and are reversed from the journal screens. */
export const REVERSIBLE = new Set(['manual', 'opening', 'opening_balance', 'reclassification', 'recurring', 'doubtful_debts', 'tally_import', 'fx_revaluation', 'write_off', 'bank_entry']);

/** Where each kind of document is undone, for the refusal's message. */
const DOCUMENT_PATH: Record<string, string> = {
  invoice: 'Sales → Invoices → the invoice → Void (or Delete)',
  bill: 'Purchases → Bills → the bill → Void (or Delete)',
  payment: 'Payments Received or Payments Made → the payment → Void',
  payment_received: 'Sales → Payments Received → the payment → Void',
  payment_made: 'Purchases → Payments Made → the payment → Void',
  transfer: 'Banking → the transfer → Delete',
  expense: 'Purchases → Expenses → the expense → Delete',
  credit_note: 'Sales → Credit Notes → the credit note → Void',
  vendor_credit: 'Purchases → Vendor Credits → the credit → Delete',
};

const addDay = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
};

/** The lock on the accountant's module, and the first date after it that can take an entry. */
export async function lockFor(ex: Executor, orgId: number): Promise<{ lockedUpto: string; reason: string | null; firstOpenDate: string } | null> {
  const lock = await ex.selectFrom('transaction_locks').select(['locked_upto', 'reason'])
    .where('org_id', '=', orgId).where('module', '=', 'accountant').executeTakeFirst();
  if (!lock?.locked_upto) return null;
  const lockedUpto = String(lock.locked_upto).slice(0, 10);
  return { lockedUpto, reason: lock.reason, firstOpenDate: addDay(lockedUpto) };
}

/** Refuse a date in a locked period or a closed year, naming the first date that is open. */
export async function assertReversalDateOpen(ex: Executor, orgId: number, date: string) {
  const lock = await lockFor(ex, orgId);
  if (lock && date <= lock.lockedUpto) {
    throw new ApiError(423,
      `The books are locked up to ${dayLabel(lock.lockedUpto)}${lock.reason ? ` (${lock.reason})` : ''}, so nothing can be posted on ${dayLabel(date)}. `
      + `The first open date is ${dayLabel(lock.firstOpenDate)}: reverse it on that date instead.`,
      'period_locked', { lockedUpto: lock.lockedUpto, firstOpenDate: lock.firstOpenDate });
  }
}

async function originalFor(trx: Trx, orgId: number, entryId: number) {
  const e = await trx.selectFrom('journal_entries')
    .select(['id', 'entry_no', 'entry_date', 'memo', 'source_type', 'source_id', 'reversal_of_entry_id', 'branch_id', 'total_debit'])
    .where('id', '=', entryId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!e) throw notFound('That journal entry does not exist.');
  if (e.reversal_of_entry_id) {
    const of = await trx.selectFrom('journal_entries').select('entry_no').where('id', '=', e.reversal_of_entry_id).executeTakeFirst();
    throw conflict(`Entry #${e.entry_no} is itself the reversal of #${of?.entry_no ?? '?'}. Post a new journal to correct it.`);
  }
  if (!REVERSIBLE.has(e.source_type)) {
    const where = DOCUMENT_PATH[e.source_type];
    throw badRequest(`Entry #${e.entry_no} was posted by a ${e.source_type.replace(/_/g, ' ')}. Void or delete that document instead${where ? ` (${where})` : ''}; that posts the reversing entry and keeps the document's record.`);
  }
  const by = await trx.selectFrom('journal_entries').select('entry_no').where('org_id', '=', orgId).where('reversal_of_entry_id', '=', entryId).executeTakeFirst();
  if (by) throw conflict(`Entry #${e.entry_no} has already been reversed by #${by.entry_no}. It cannot be reversed twice.`);
  const waiting = await trx.selectFrom('held_journals').select(['id', 'kind', 'entry_date'])
    .where('org_id', '=', orgId).where('reverses_entry_id', '=', entryId).where('status', '=', 'held').executeTakeFirst();
  if (waiting) {
    throw conflict(waiting.kind === 'approval'
      ? `A reversal of #${e.entry_no} is already waiting for approval (H-${waiting.id}).`
      : `#${e.entry_no} is already set to reverse itself on ${dayLabel(String(waiting.entry_date).slice(0, 10))} (H-${waiting.id}).`);
  }
  return e;
}

/** The reversing lines, for a held reversal's display: every debit a credit and every credit a debit. */
async function swappedLines(ex: Executor, entryId: number) {
  const lines = await ex.selectFrom('journal_lines').select(['account_id', 'debit', 'credit', 'description', 'contact_id', 'cost_centre_id'])
    .where('entry_id', '=', entryId).orderBy('line_no').execute();
  return lines.map((l) => ({
    accountId: l.account_id, debitPaise: toPaiseFromSql(l.credit), creditPaise: toPaiseFromSql(l.debit),
    description: l.description, contactId: l.contact_id, costCentreId: l.cost_centre_id,
  }));
}

export type ReversalResult =
  | { held: false; entryNo: number; reversalId: number; reversalNo: number }
  | { held: true; entryNo: number; heldId: number; approverRole: RoleName };

/**
 * Reverse a posted entry on a date, for a reason: posted now, or held for a
 * second person when a journal approval rule covers the amount.
 */
export async function requestReversal(
  trx: Trx, orgId: number, userId: number | null, entryId: number, input: { date: string; reason: string },
): Promise<ReversalResult> {
  const reason = input.reason.trim();
  if (reason.length < 3) throw badRequest('Say why the entry is being reversed. The reason is kept with the reversal and in the audit trail.');
  const e = await originalFor(trx, orgId, entryId);
  if (input.date < String(e.entry_date).slice(0, 10)) {
    throw badRequest(`A reversal cannot be dated before the entry it reverses (#${e.entry_no} is dated ${dayLabel(String(e.entry_date).slice(0, 10))}).`);
  }
  await assertReversalDateOpen(trx, orgId, input.date);
  const total = toPaiseFromSql(e.total_debit);
  const memo = `Reversal of #${e.entry_no}: ${reason}`.slice(0, 500);
  const rule = await ruleFor(trx, orgId, 'journal', total);
  if (rule) {
    const id = Number((await trx.insertInto('held_journals').values({
      org_id: orgId, branch_id: e.branch_id, kind: 'approval', entry_date: input.date, memo,
      entry_lines: JSON.stringify(await swappedLines(trx, entryId)), total_amount: toSqlFromPaise(total),
      created_by_user_id: userId, reverses_entry_id: entryId, reason,
    }).executeTakeFirstOrThrow()).insertId);
    await recordApprovalAction(trx, orgId, 'journal', id, 'submitted', userId, reason);
    return { held: true, entryNo: e.entry_no, heldId: id, approverRole: rule.approverRole };
  }
  const reversal = await postReversal(trx, orgId, entryId, { date: input.date, reason, memo, kind: 'manual', requestedBy: userId, approvedBy: null, postedBy: userId });
  return { held: false, entryNo: e.entry_no, reversalId: reversal.id, reversalNo: reversal.entryNo };
}

/**
 * Post the reversal and keep its reason and who asked for it and who approved
 * it. Whatever the entry settled is owed again (journals.ts reverseJournal).
 */
export async function postReversal(
  trx: Trx, orgId: number, entryId: number,
  o: { date: string; reason: string; memo?: string; kind: 'manual' | 'approved' | 'scheduled'; requestedBy: number | null; approvedBy: number | null; postedBy: number | null },
) {
  await assertReversalDateOpen(trx, orgId, o.date);
  const e = await trx.selectFrom('journal_entries').select('entry_no').where('id', '=', entryId).where('org_id', '=', orgId).executeTakeFirstOrThrow();
  const reversal = await reverseJournal(trx, orgId, o.postedBy, entryId, { date: o.date, memo: o.memo ?? `Reversal of #${e.entry_no}: ${o.reason}`.slice(0, 500) });
  await trx.insertInto('journal_reversals').values({
    org_id: orgId, entry_id: entryId, reversal_entry_id: reversal.id, reverse_on: o.date, reason: o.reason.slice(0, 500),
    kind: o.kind, requested_by_user_id: o.requestedBy, approved_by_user_id: o.approvedBy,
  }).execute();
  return reversal;
}

export interface ReversalPair {
  entryId: string; entryNo: number; entryDate: string; memo: string | null; sourceType: string; sourceId: string | null;
  reversalId: string | null; reversalNo: number | null; reversalDate: string | null;
  amountPaise: Paise;
  reason: string | null;
  /** Who asked for it, who approved it (maker and checker), and how it came about. */
  requestedBy: string | null; approvedBy: string | null;
  kind: 'manual' | 'approved' | 'scheduled' | 'document' | 'waiting_approval' | 'scheduled_pending';
  heldId: string | null;
}

/**
 * Every reversal pair in the books in the period (by the reversal's date, or
 * the date it is due), journals and documents alike, with the reason and the
 * people; and the reversals not yet posted: waiting for approval, or due on a
 * later date.
 */
export async function reversalRegister(ex: Executor, orgId: number, opts: { from?: string; to?: string } = {}): Promise<ReversalPair[]> {
  const from = opts.from ?? '1900-01-01';
  const to = opts.to ?? '2999-12-31';
  const { rows } = await sql<{
    entry_id: number; entry_no: number; entry_date: string; memo: string | null; source_type: string; source_id: number | null;
    reversal_id: number; reversal_no: number; reversal_date: string; amount: string;
    jr_reason: string | null; jr_kind: string | null; requested_by: string | null; approved_by: string | null; posted_by: string | null;
    doc_reason: string | null; audit_reason: string | null;
  }>`
    SELECT o.id AS entry_id, o.entry_no, DATE_FORMAT(o.entry_date, '%Y-%m-%d') AS entry_date, o.memo, o.source_type, o.source_id,
           r.id AS reversal_id, r.entry_no AS reversal_no, DATE_FORMAT(r.entry_date, '%Y-%m-%d') AS reversal_date, o.total_debit AS amount,
           jr.reason AS jr_reason, jr.kind AS jr_kind, ru.name AS requested_by, au.name AS approved_by, pu.name AS posted_by,
           dd.reason AS doc_reason,
           (SELECT a.reason FROM audit_log a
             WHERE a.org_id = o.org_id AND a.target_type = o.source_type AND a.target_id = CAST(o.source_id AS CHAR)
               AND a.action IN ('void', 'delete') AND a.reason IS NOT NULL
             ORDER BY a.id DESC LIMIT 1) AS audit_reason
      FROM journal_entries r
      JOIN journal_entries o ON o.id = r.reversal_of_entry_id
      LEFT JOIN journal_reversals jr ON jr.reversal_entry_id = r.id
      LEFT JOIN users ru ON ru.id = jr.requested_by_user_id
      LEFT JOIN users au ON au.id = jr.approved_by_user_id
      LEFT JOIN users pu ON pu.id = r.posted_by_user_id
      LEFT JOIN deleted_documents dd ON dd.org_id = r.org_id AND dd.reversal_entry_id = r.id
     WHERE r.org_id = ${orgId} AND r.entry_date BETWEEN ${from} AND ${to}
     ORDER BY r.entry_date DESC, r.entry_no DESC`.execute(ex);
  const held = await ex.selectFrom('held_journals as h')
    .innerJoin('journal_entries as o', 'o.id', 'h.reverses_entry_id')
    .leftJoin('users as u', 'u.id', 'h.created_by_user_id')
    .select(['h.id', 'h.kind', 'h.entry_date', 'h.reason', 'h.memo', 'o.id as entry_id', 'o.entry_no', 'o.entry_date as o_date', 'o.memo as o_memo', 'o.source_type', 'o.source_id', 'o.total_debit', 'u.name'])
    .where('h.org_id', '=', orgId).where('h.status', '=', 'held').where('h.entry_date', '>=', from).where('h.entry_date', '<=', to)
    .orderBy('h.entry_date').execute();
  return [
    ...held.map((h): ReversalPair => ({
      entryId: String(h.entry_id), entryNo: h.entry_no, entryDate: String(h.o_date).slice(0, 10), memo: h.o_memo, sourceType: h.source_type,
      sourceId: h.source_id ? String(h.source_id) : null, reversalId: null, reversalNo: null, reversalDate: String(h.entry_date).slice(0, 10),
      amountPaise: toPaiseFromSql(h.total_debit), reason: h.reason ?? h.memo, requestedBy: h.name, approvedBy: null,
      kind: h.kind === 'approval' ? 'waiting_approval' : 'scheduled_pending', heldId: String(h.id),
    })),
    ...rows.map((r): ReversalPair => ({
      entryId: String(r.entry_id), entryNo: r.entry_no, entryDate: r.entry_date, memo: r.memo, sourceType: r.source_type,
      sourceId: r.source_id ? String(r.source_id) : null, reversalId: String(r.reversal_id), reversalNo: r.reversal_no, reversalDate: r.reversal_date,
      amountPaise: toPaiseFromSql(r.amount), reason: r.jr_reason ?? r.doc_reason ?? r.audit_reason ?? null,
      requestedBy: r.requested_by ?? r.posted_by, approvedBy: r.approved_by,
      kind: (r.jr_kind as ReversalPair['kind'] | null) ?? (REVERSIBLE.has(r.source_type) ? 'manual' : 'document'), heldId: null,
    })),
  ];
}
