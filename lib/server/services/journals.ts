import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Manual journals, bill by bill.
//
// A journal line on a customer's or supplier's account can say which of their
// documents it settles: New Ref, Against Ref and On Account in Tally's words.
// A credit to Receivables against an invoice lowers what that invoice owes,
// as a receipt would; a debit to Payables against a bill does the same for the
// bill. A line that names nothing is on account, and ageing lays it against
// the newest documents as it always has.
//
// Writing off a bad debt is one such journal — Dr Bad Debts, Cr the customer
// against the invoice — and so is reversing any of them: the settlement is
// undone along with the entry.
//
// The provision for doubtful debts is not bill-wise: it is an estimate against
// receivables as a whole, raised or lowered to a target at a date.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { postEntry, reverseEntry, type DraftLine } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { ApiError, badRequest, conflict, notFound } from '../http';
import { applyAllocations } from './payments';
import { ruleFor } from './approvals';
import { ageing } from '../reports/statements';

export interface JournalLineInput {
  accountId: number;
  /** The cost centre of an income or expense line. */
  costCentreId?: number | null;
  debitPaise?: Paise;
  creditPaise?: Paise;
  description?: string | null;
  contactId?: number | null;
  /** Documents of the line's party this line settles. Receivables credits and payables debits only. */
  against?: { targetType: 'invoice' | 'bill' | 'opening'; targetId: number; amountPaise: Paise }[];
}

export interface ManualJournalInput {
  branchId: number;
  date: string;
  memo: string;
  lines: JournalLineInput[];
  sourceType?: string;
  /**
   * An accrual or provision that should undo itself: reversed in full on this
   * date, posted now with the entry. Month-end accruals reverse on the 1st.
   */
  reverseOn?: string | null;
  /** Approved by a second person, where a journal approval rule asks for one. */
  approved?: boolean;
}

export async function postManualJournal(trx: Trx, orgId: number, userId: number | null, input: ManualJournalInput) {
  // The approval rule is checked here, where the entry is written, so no screen
  // or import can go round it. saveJournal holds a caught entry instead.
  if ((input.sourceType ?? 'manual') === 'manual' && !input.approved) {
    const rule = await ruleFor(trx, orgId, 'journal', input.lines.reduce((t, l) => t + (l.debitPaise ?? 0), 0));
    if (rule) {
      throw new ApiError(403, `Journals of ₹${(rule.thresholdPaise / 100).toLocaleString('en-IN')} and above need approval by ${rule.approverRole === 'admin' ? 'an admin' : `an ${rule.approverRole}`} before they post.`, 'needs_approval');
    }
  }
  const acc = await accountIds(trx, orgId);
  const ar = requireAccount(acc, CODE.AR);
  const ap = requireAccount(acc, CODE.AP);

  // Check every allocation before anything is written.
  const settles: {
    kind: 'received' | 'made'; contactId: number;
    allocations: { targetType: 'invoice' | 'bill' | 'opening'; targetId: number; amountPaise: Paise }[];
  }[] = [];
  for (const [i, l] of input.lines.entries()) {
    if (!l.against?.length) continue;
    const n = i + 1;
    if (!l.contactId) throw badRequest(`Line ${n} settles documents, so it needs the party they belong to.`);
    const debit = l.debitPaise ?? 0;
    const credit = l.creditPaise ?? 0;
    let kind: 'received' | 'made';
    if (l.accountId === ar && credit > 0) kind = 'received';
    else if (l.accountId === ap && debit > 0) kind = 'made';
    else {
      throw badRequest(
        `Line ${n}: only a credit to Accounts Receivable or a debit to Accounts Payable settles a document. ` +
          'Anything else on a party account is on account.',
      );
    }
    const total = l.against.reduce((t, a) => t + a.amountPaise, 0);
    if (l.against.some((a) => !(a.amountPaise > 0))) throw badRequest(`Line ${n}: each amount settled must be above zero.`);
    if (total > (kind === 'received' ? credit : debit)) {
      throw badRequest(`Line ${n} settles ${(total / 100).toFixed(2)}, more than the line's own ${((kind === 'received' ? credit : debit) / 100).toFixed(2)}.`);
    }
    settles.push({ kind, contactId: l.contactId, allocations: l.against.map((a) => ({ ...a })) });
  }

  if (input.reverseOn) {
    if (input.reverseOn <= input.date) throw badRequest('An entry reverses on a later date than its own.');
    if (settles.length) throw badRequest('An entry that settles documents cannot reverse itself; reverse it by hand if it must be undone.');
  }

  const entry = await postEntry(trx, {
    orgId, branchId: input.branchId, date: input.date, memo: input.memo,
    sourceType: input.sourceType ?? 'manual', userId, module: 'accountant',
    lines: input.lines.map((l) => ({
      accountId: l.accountId, debit: l.debitPaise ?? 0, credit: l.creditPaise ?? 0,
      description: l.description, contactId: l.contactId ?? null, costCentreId: l.costCentreId ?? null,
    })),
  });

  for (const s of settles) {
    await applyAllocations(trx, orgId, s.allocations, 1, { kind: s.kind, contactId: s.contactId });
    await trx.insertInto('journal_allocations').values(s.allocations.map((a) => ({
      org_id: orgId, entry_id: entry.id, contact_id: s.contactId, target_type: a.targetType, target_id: a.targetId,
      amount: toSqlFromPaise(a.amountPaise),
    }))).execute();
  }
  if (input.reverseOn) {
    const reversal = await reverseEntry(trx, orgId, entry.id, { date: input.reverseOn, memo: `Automatic reversal of: ${input.memo}`, userId, module: 'accountant' });
    return { ...entry, reversalId: reversal.id };
  }
  return entry;
}

/**
 * Reverse a journal, and give back whatever it settled. The documents it paid
 * off are owed again — the same rule as voiding a payment.
 */
export async function reverseJournal(
  trx: Trx, orgId: number, userId: number | null, entryId: number, opts: { date?: string; memo?: string } = {},
) {
  const allocations = await trx.selectFrom('journal_allocations').selectAll()
    .where('org_id', '=', orgId).where('entry_id', '=', entryId).where('reversed', '=', 0).execute();
  const reversal = await reverseEntry(trx, orgId, entryId, { ...opts, userId, module: 'accountant' });
  for (const a of allocations) {
    const kind = a.target_type === 'bill' ? 'made' as const
      : a.target_type === 'invoice' ? 'received' as const
        : await openingKind(trx, a.target_id);
    await applyAllocations(trx, orgId, [{ targetType: a.target_type, targetId: a.target_id, amountPaise: toPaiseFromSql(a.amount) }], -1,
      { kind, contactId: a.contact_id });
  }
  if (allocations.length) {
    await trx.updateTable('journal_allocations').set({ reversed: 1 }).where('entry_id', '=', entryId).execute();
  }
  return reversal;
}

async function openingKind(ex: Executor, id: number): Promise<'received' | 'made'> {
  const d = await ex.selectFrom('opening_documents').select('kind').where('id', '=', id).executeTakeFirstOrThrow();
  return d.kind === 'receivable' ? 'received' : 'made';
}

/**
 * Write off what is left on an invoice: Dr Bad Debts Written Off, Cr the
 * customer against the invoice. The GST charged on it was paid when the
 * invoice was issued and does not come back by writing it off.
 */
export async function writeOffInvoice(
  trx: Trx, orgId: number, userId: number | null, invoiceId: number, input: { date: string; reason: string; amountPaise?: Paise },
) {
  const inv = await trx.selectFrom('invoices').select(['id', 'number', 'branch_id', 'customer_id', 'total', 'amount_paid', 'status', 'invoice_date'])
    .where('id', '=', invoiceId).where('org_id', '=', orgId).executeTakeFirst();
  if (!inv) throw notFound('Invoice not found.');
  if (inv.status === 'void' || inv.status === 'draft') throw conflict(`Invoice ${inv.number} is ${inv.status}; there is nothing owed on it.`);
  const left = toPaiseFromSql(inv.total) - toPaiseFromSql(inv.amount_paid);
  const amount = input.amountPaise ?? left;
  if (!(amount > 0) || amount > left) throw badRequest(`Invoice ${inv.number} has ${(left / 100).toFixed(2)} left; write off no more than that.`);
  if (input.date < String(inv.invoice_date).slice(0, 10)) throw badRequest('A debt cannot be written off before the invoice was raised.');
  if (input.reason.trim().length < 3) throw badRequest('Say why the debt is being written off.');
  const acc = await accountIds(trx, orgId);
  return postManualJournal(trx, orgId, userId, {
    branchId: inv.branch_id, date: input.date, sourceType: 'write_off',
    memo: `Bad debt written off: invoice ${inv.number} — ${input.reason.trim()}`,
    lines: [
      { accountId: requireAccount(acc, CODE.WRITE_OFF), debitPaise: amount, description: `Invoice ${inv.number}` },
      {
        accountId: requireAccount(acc, CODE.AR), creditPaise: amount, contactId: inv.customer_id, description: `Written off: ${inv.number}`,
        against: [{ targetType: 'invoice', targetId: inv.id, amountPaise: amount }],
      },
    ],
  });
}

// ── Provision for doubtful debts ─────────────────────────────────────────────

export interface ProvisionPlan {
  asOf: string;
  /** The percentage of each age bucket expected not to be collected. */
  rates: Record<string, number>;
  buckets: { bucket: string; owedPaise: Paise; ratePct: number; provisionPaise: Paise }[];
  targetPaise: Paise;
  currentPaise: Paise;
  /** What the adjusting entry would post: positive raises the provision. */
  changePaise: Paise;
}

/** A reasonable starting point; the accountant sets their own. */
export const DEFAULT_PROVISION_RATES: Record<string, number> = { Current: 0, '1–15': 0, '16–30': 0, '31–45': 5, '46–60': 10, '60+': 25 };

/** What the provision should be at a date, by age bucket, and how far it is from that now. */
export async function provisionPlan(ex: Executor, orgId: number, asOf: string, rates = DEFAULT_PROVISION_RATES): Promise<ProvisionPlan> {
  const [ag, current] = await Promise.all([
    ageing(ex, orgId, 'receivable', asOf),
    sql<{ v: string }>`
      SELECT COALESCE(SUM(l.credit - l.debit), 0) AS v FROM journal_lines l JOIN accounts a ON a.id = l.account_id
       WHERE l.org_id = ${orgId} AND a.code = ${CODE.DOUBTFUL_DEBTS_PROVISION} AND l.entry_date <= ${asOf}
    `.execute(ex),
  ]);
  const buckets = Object.entries(ag.totals).map(([bucket, owed]) => {
    const ratePct = rates[bucket] ?? 0;
    return { bucket, owedPaise: owed, ratePct, provisionPaise: Math.round((Math.max(0, owed) * ratePct) / 100) };
  });
  const target = buckets.reduce((t, b) => t + b.provisionPaise, 0);
  const currentPaise = toPaiseFromSql(current.rows[0]?.v ?? '0');
  return { asOf, rates, buckets, targetPaise: target, currentPaise, changePaise: target - currentPaise };
}

/** Bring the provision to its target at a date with one adjusting entry. */
export async function adjustProvision(
  trx: Trx, orgId: number, userId: number | null, branchId: number, asOf: string, rates = DEFAULT_PROVISION_RATES,
) {
  const plan = await provisionPlan(trx, orgId, asOf, rates);
  if (plan.changePaise === 0) return { entryId: null, plan };
  const acc = await accountIds(trx, orgId);
  const exp = requireAccount(acc, CODE.DOUBTFUL_DEBTS_EXPENSE);
  const prov = requireAccount(acc, CODE.DOUBTFUL_DEBTS_PROVISION);
  const amt = Math.abs(plan.changePaise);
  const lines: DraftLine[] = plan.changePaise > 0
    ? [{ accountId: exp, debit: amt }, { accountId: prov, credit: amt }]
    : [{ accountId: prov, debit: amt }, { accountId: exp, credit: amt }];
  const entry = await postEntry(trx, {
    orgId, branchId, date: asOf, module: 'accountant', userId, sourceType: 'doubtful_debts',
    memo: `Provision for doubtful debts ${plan.changePaise > 0 ? 'raised' : 'released'} to ₹${(plan.targetPaise / 100).toLocaleString('en-IN')} at ${asOf}`,
    lines,
  });
  return { entryId: entry.id, plan };
}
