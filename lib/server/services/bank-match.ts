import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Zoho Books' bank matching, on top of the statement lines banking.ts imports.
//
// Match Transactions: for a line, what in the books it could be. Open
// invoices (money in) and open bills (money out), and payments, expenses,
// transfers and journals already recorded through this account that no line
// has claimed yet, scored by lib/bank-match-score.ts. One line can be matched
// to several of them at once; an amount left over is posted to an account the
// person names (the bank's charge, usually).
//
// Categorize Manually: what the money was, by Zoho's categories
// (lib/bank-categories.ts), each posted through the documents a person would
// have raised: a receipt for a customer payment, an expense, a transfer.
//
// Every link is kept in bank_transaction_links, marked when the match created
// the thing it links to, so unmatching takes back exactly what matching did:
// a receipt recorded for an invoice is voided and the invoice is open again;
// a payment that was already in the books is only let go.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { postEntry, reverseEntry, type DraftLine } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { ApiError, badRequest, notFound } from '../http';
import { receivePayment, makePayment, voidPayment, type AllocationInput } from './payments';
import { createExpense } from './purchases';
import { createTransfer } from './banking';
import { categoryOf, type BankCategoryKey } from '../../bank-categories';
import {
  groupMatches, modeFromNarration, rankCandidates, scoreCandidate,
  type BankLineFacts, type Candidate, type CandidateType, type GroupMatch, type ScoredCandidate,
} from '../../bank-match-score';

export interface BankLine extends BankLineFacts {
  id: number;
  bankAccountId: number;
  ledgerAccountId: number;
  bankName: string;
  status: string;
}

const ymd = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

export async function bankLine(ex: Executor, orgId: number, txnId: number): Promise<BankLine> {
  const t = await ex.selectFrom('bank_transactions as t')
    .innerJoin('bank_accounts as b', 'b.id', 't.bank_account_id')
    .select(['t.id', 't.txn_date', 't.narration', 't.reference', 't.deposit', 't.withdrawal', 't.status', 't.bank_account_id', 'b.ledger_account_id', 'b.name'])
    .where('t.id', '=', txnId).where('t.org_id', '=', orgId).executeTakeFirst();
  if (!t) throw notFound('That bank line does not exist.');
  const deposit = toPaiseFromSql(t.deposit);
  return {
    id: t.id, date: ymd(t.txn_date), narration: t.narration, reference: t.reference,
    amountPaise: deposit || toPaiseFromSql(t.withdrawal), direction: deposit > 0 ? 'in' : 'out',
    bankAccountId: t.bank_account_id, ledgerAccountId: t.ledger_account_id, bankName: t.name, status: t.status,
  };
}

type Taken = Record<'payment' | 'expense' | 'transfer' | 'journal_entry', Set<number>>;

/** What some statement line already claims: a recorded transaction is matched to one line only. */
export async function takenTargets(ex: Executor, orgId: number): Promise<Taken> {
  const taken: Taken = { payment: new Set(), expense: new Set(), transfer: new Set(), journal_entry: new Set() };
  const direct = await ex.selectFrom('bank_transactions').select(['matched_type', 'matched_id'])
    .where('org_id', '=', orgId).where('status', '=', 'matched').where('matched_id', 'is not', null).execute();
  for (const r of direct) (taken as Record<string, Set<number>>)[r.matched_type ?? '']?.add(Number(r.matched_id));
  const links = await ex.selectFrom('bank_transaction_links').select(['target_type', 'target_id']).where('org_id', '=', orgId).execute();
  for (const r of links) (taken as Record<string, Set<number>>)[r.target_type]?.add(Number(r.target_id));
  return taken;
}

/** A party's names as a bank narration may carry them. */
const namesOf = (c: { display_name: string; legal_name?: string | null; business_legal_name?: string | null; business_trade_name?: string | null; bank_account_name?: string | null; first_name?: string | null; last_name?: string | null }) =>
  [c.display_name, c.legal_name, c.business_legal_name, c.business_trade_name, c.bank_account_name, [c.first_name, c.last_name].filter(Boolean).join(' ')]
    .filter((n): n is string => !!n && n.trim().length > 0);

/** Sources whose journals are their own kind of candidate, or are this matching's own. */
const NOT_JOURNALS = ['payment_received', 'payment_made', 'expense', 'transfer', 'bank_txn', 'opening_balance'];

/**
 * Everything in the books a line of this account and direction could be: open
 * documents, and recorded transactions through this account no line has claimed.
 */
export async function candidatePool(ex: Executor, orgId: number, bank: { id: number; ledgerAccountId: number }, direction: 'in' | 'out', taken?: Taken): Promise<Candidate[]> {
  const t = taken ?? await takenTargets(ex, orgId);
  const out: Candidate[] = [];
  const contactCols = ['c.display_name', 'c.legal_name', 'c.business_legal_name', 'c.business_trade_name', 'c.bank_account_name', 'c.first_name', 'c.last_name'] as const;

  if (direction === 'in') {
    const inv = await ex.selectFrom('invoices as i').innerJoin('contacts as c', 'c.id', 'i.customer_id')
      .select(['i.id', 'i.number', 'i.invoice_date', 'i.total', 'i.amount_paid', 'i.customer_id', ...contactCols])
      .where('i.org_id', '=', orgId).where('i.currency', '=', 'INR')
      .where('i.status', 'in', ['approved', 'sent', 'overdue', 'partially_paid']).execute();
    for (const r of inv) {
      const left = toPaiseFromSql(r.total) - toPaiseFromSql(r.amount_paid);
      if (left <= 0) continue;
      out.push({ key: `invoice:${r.id}`, type: 'invoice', id: String(r.id), number: r.number, party: r.display_name, contactId: String(r.customer_id),
        date: ymd(r.invoice_date), amountPaise: left, totalPaise: toPaiseFromSql(r.total), names: namesOf(r) });
    }
  } else {
    const bills = await ex.selectFrom('bills as b').innerJoin('contacts as c', 'c.id', 'b.vendor_id')
      .select(['b.id', 'b.internal_no', 'b.vendor_invoice_no', 'b.bill_date', 'b.total', 'b.amount_paid', 'b.vendor_id', ...contactCols])
      .where('b.org_id', '=', orgId).where('b.currency', '=', 'INR')
      .where('b.status', 'in', ['open', 'overdue', 'partially_paid']).execute();
    for (const r of bills) {
      const left = toPaiseFromSql(r.total) - toPaiseFromSql(r.amount_paid);
      if (left <= 0) continue;
      out.push({ key: `bill:${r.id}`, type: 'bill', id: String(r.id), number: r.vendor_invoice_no || r.internal_no, party: r.display_name, contactId: String(r.vendor_id),
        date: ymd(r.bill_date), amountPaise: left, totalPaise: toPaiseFromSql(r.total), reference: r.internal_no, names: namesOf(r) });
    }
  }

  const pays = await ex.selectFrom('payments as p').innerJoin('contacts as c', 'c.id', 'p.contact_id')
    .select(['p.id', 'p.number', 'p.payment_date', 'p.amount', 'p.bank_charges', 'p.reference', 'p.contact_id', ...contactCols])
    .where('p.org_id', '=', orgId).where('p.bank_account_id', '=', bank.id).where('p.status', '<>', 'void')
    .where('p.kind', '=', direction === 'in' ? 'received' : 'made').execute();
  for (const r of pays) {
    if (t.payment.has(r.id)) continue;
    // What reached or left the bank: a receipt less the charge deducted on the way, a payment plus it.
    const charges = toPaiseFromSql(r.bank_charges);
    const amount = direction === 'in' ? toPaiseFromSql(r.amount) - charges : toPaiseFromSql(r.amount) + charges;
    out.push({ key: `payment:${r.id}`, type: 'payment', id: String(r.id), number: r.number, party: r.display_name, contactId: String(r.contact_id),
      date: ymd(r.payment_date), amountPaise: amount, reference: r.reference, names: namesOf(r) });
  }

  if (direction === 'out') {
    const exps = await ex.selectFrom('expenses as e').leftJoin('contacts as c', 'c.id', 'e.vendor_id')
      .innerJoin('accounts as a', 'a.id', 'e.account_id')
      .select(['e.id', 'e.number', 'e.expense_date', 'e.total', 'e.reference', 'e.vendor_id', 'a.name as account_name', ...contactCols])
      .where('e.org_id', '=', orgId).where('e.paid_through_bank_account_id', '=', bank.id).where('e.status', '=', 'recorded').execute();
    for (const r of exps) {
      if (t.expense.has(r.id)) continue;
      out.push({ key: `expense:${r.id}`, type: 'expense', id: String(r.id), number: r.number, party: r.display_name ?? r.account_name,
        contactId: r.vendor_id ? String(r.vendor_id) : null, date: ymd(r.expense_date), amountPaise: toPaiseFromSql(r.total), reference: r.reference,
        names: r.display_name ? namesOf(r as never) : [] });
    }
  }

  const transfers = await ex.selectFrom('bank_transfers as x')
    .innerJoin('bank_accounts as other', (j) => j.onRef('other.id', '=', direction === 'in' ? 'x.from_bank_account_id' : 'x.to_bank_account_id'))
    .select(['x.id', 'x.transfer_date', 'x.amount', 'x.reference', 'other.name as other_name'])
    .where('x.org_id', '=', orgId).where(direction === 'in' ? 'x.to_bank_account_id' : 'x.from_bank_account_id', '=', bank.id).execute();
  for (const r of transfers) {
    if (t.transfer.has(r.id)) continue;
    out.push({ key: `transfer:${r.id}`, type: 'transfer', id: String(r.id), number: `Transfer ${direction === 'in' ? 'from' : 'to'} ${r.other_name}`,
      party: r.other_name, contactId: null, date: ymd(r.transfer_date), amountPaise: toPaiseFromSql(r.amount), reference: r.reference });
  }

  // Journals through this account from anywhere else: by hand, recurring, brought from Tally.
  const { rows: journals } = await sql<{ id: number; entry_no: number; entry_date: string; memo: string | null; net: string }>`
    SELECT e.id, e.entry_no, e.entry_date, e.memo, SUM(l.debit - l.credit) AS net
      FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
     WHERE e.org_id = ${orgId} AND l.account_id = ${bank.ledgerAccountId}
       AND e.source_type NOT IN (${sql.join(NOT_JOURNALS)})
       AND e.reversal_of_entry_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reversal_of_entry_id = e.id)
     GROUP BY e.id, e.entry_no, e.entry_date, e.memo`.execute(ex);
  for (const r of journals) {
    if (t.journal_entry.has(r.id)) continue;
    const net = toPaiseFromSql(r.net);
    if (direction === 'in' ? net <= 0 : net >= 0) continue;
    out.push({ key: `journal:${r.id}`, type: 'journal', id: String(r.id), number: `Journal ${r.entry_no}`, party: r.memo, contactId: null,
      date: ymd(r.entry_date), amountPaise: Math.abs(net) });
  }
  return out;
}

export interface MatchFilters {
  type?: CandidateType | null;
  contactId?: string | null;
  from?: string | null;
  to?: string | null;
  minPaise?: number | null;
  maxPaise?: number | null;
  q?: string | null;
}

/** Zoho's matching panel for one line: Best Matches, Possible Matches, and a search over everything else. */
export async function findMatches(ex: Executor, orgId: number, txnId: number, filters?: MatchFilters): Promise<{
  line: BankLine; best: ScoredCandidate[]; possible: ScoredCandidate[]; groups: GroupMatch[]; results: ScoredCandidate[] | null;
}> {
  const line = await bankLine(ex, orgId, txnId);
  const pool = await candidatePool(ex, orgId, { id: line.bankAccountId, ledgerAccountId: line.ledgerAccountId }, line.direction);
  const { best, possible } = rankCandidates(line, pool);
  const groups = best.length ? [] : groupMatches(line, [...possible]);
  let results: ScoredCandidate[] | null = null;
  if (filters) {
    const q = filters.q?.trim().toLowerCase();
    results = pool
      .filter((c) => !filters.type || c.type === filters.type)
      .filter((c) => !filters.contactId || c.contactId === filters.contactId)
      .filter((c) => !filters.from || c.date >= filters.from)
      .filter((c) => !filters.to || c.date <= filters.to)
      .filter((c) => filters.minPaise == null || c.amountPaise >= filters.minPaise)
      .filter((c) => filters.maxPaise == null || c.amountPaise <= filters.maxPaise)
      .filter((c) => !q || `${c.number} ${c.party ?? ''} ${c.reference ?? ''}`.toLowerCase().includes(q))
      .map((c) => scoreCandidate(line, c))
      .sort((a, b) => b.score - a.score || b.date.localeCompare(a.date))
      .slice(0, 100);
  }
  return { line, best, possible, groups, results };
}

/** For the list: each unmatched line's confident matches, so the row can say a match was found. */
export async function bestMatchesFor(ex: Executor, orgId: number, txnIds: number[]): Promise<Map<number, ScoredCandidate[]>> {
  const out = new Map<number, ScoredCandidate[]>();
  if (!txnIds.length) return out;
  const rows = await ex.selectFrom('bank_transactions as t').innerJoin('bank_accounts as b', 'b.id', 't.bank_account_id')
    .select(['t.id', 't.txn_date', 't.narration', 't.reference', 't.deposit', 't.withdrawal', 't.bank_account_id', 'b.ledger_account_id'])
    .where('t.org_id', '=', orgId).where('t.id', 'in', txnIds).where('t.status', '=', 'unmatched').execute();
  const taken = await takenTargets(ex, orgId);
  const pools = new Map<string, Candidate[]>();
  for (const r of rows) {
    const deposit = toPaiseFromSql(r.deposit);
    const direction = deposit > 0 ? 'in' : 'out';
    const k = `${r.bank_account_id}:${direction}`;
    if (!pools.has(k)) pools.set(k, await candidatePool(ex, orgId, { id: r.bank_account_id, ledgerAccountId: r.ledger_account_id }, direction, taken));
    const line: BankLineFacts = { date: ymd(r.txn_date), amountPaise: deposit || toPaiseFromSql(r.withdrawal), direction, narration: r.narration, reference: r.reference };
    const { best } = rankCandidates(line, pools.get(k)!);
    if (best.length) out.set(r.id, best);
  }
  return out;
}

// ── Matching ─────────────────────────────────────────────────────────────────

export interface MatchPick {
  type: CandidateType;
  id: number;
  /** For an open invoice or bill: how much of it this line pays (all that is left, when omitted). */
  amountPaise?: Paise;
}

interface LinkRow { target_type: 'payment' | 'expense' | 'transfer' | 'journal_entry'; target_id: number; amount: Paise; created: boolean; category?: string | null; refundedPaymentId?: number | null }

async function primaryBranch(ex: Executor, orgId: number): Promise<number> {
  const b = await ex.selectFrom('branches').select('id').where('org_id', '=', orgId).where('is_primary', '=', 1).executeTakeFirst();
  if (!b) throw notFound('No primary branch is configured.');
  return b.id;
}

async function assertOpen(line: BankLine) {
  if (line.status === 'matched') throw new ApiError(409, 'That line is already matched. Unmatch it first.', 'conflict');
  if (line.status === 'excluded') throw badRequest('That line is excluded. Restore it first.');
}

async function writeLinks(trx: Trx, orgId: number, userId: number | null, line: BankLine, links: LinkRow[]) {
  if (!links.length) throw badRequest('Nothing to match the line to.');
  await trx.insertInto('bank_transaction_links').values(links.map((l) => ({
    org_id: orgId, bank_transaction_id: line.id, target_type: l.target_type, target_id: l.target_id,
    amount: toSqlFromPaise(l.amount), created_by_match: l.created ? 1 : 0, category: l.category ?? null,
    refunded_payment_id: l.refundedPaymentId ?? null, created_by_user_id: userId,
  }))).execute();
  const single = links.length === 1 ? links[0] : null;
  await trx.updateTable('bank_transactions').set({
    status: 'matched', matched_type: single ? single.target_type : 'multiple', matched_id: single ? single.target_id : null,
    matched_at: new Date(), matched_by_user_id: userId,
  }).where('id', '=', line.id).execute();
}

/** A journal for what a match leaves over, or for a category with no document: the bank on one side. */
async function postAgainstBank(trx: Trx, orgId: number, userId: number | null, line: BankMoney, other: DraftLine[], memo: string): Promise<number> {
  const amount = other.reduce((t, l) => t + (l.debit ?? 0) - (l.credit ?? 0), 0);
  // Money in: the bank is debited by what the other side credits; money out, the reverse.
  const bankSide: DraftLine = amount < 0
    ? { accountId: line.ledgerAccountId, debit: -amount, description: line.narration.slice(0, 200) }
    : { accountId: line.ledgerAccountId, credit: amount, description: line.narration.slice(0, 200) };
  const entry = await postEntry(trx, {
    orgId, branchId: await primaryBranch(trx, orgId), date: line.date, memo: memo.slice(0, 500),
    // Made from a statement line, or typed in on the account (Add Transaction).
    sourceType: line.id ? 'bank_txn' : 'bank_entry', sourceId: line.id ?? undefined, userId, module: 'banking', lines: [bankSide, ...other],
  });
  return entry.id;
}

/**
 * Match one statement line to one or more things in the books, as Zoho's Match
 * button does. Open invoices become one receipt per customer, open bills one
 * payment per vendor, recorded into this account on the line's date; what was
 * already recorded is linked as it is. If the line and the picks differ, the
 * difference is posted to `differenceAccountId` (Bank Charges, usually), or
 * the match is refused, because a match that hides a difference is worse than
 * none.
 */
export async function matchLine(
  trx: Trx, orgId: number, userId: number | null, txnId: number, picks: MatchPick[],
  opts: { differenceAccountId?: number | null } = {},
): Promise<{ matched: number; created: string[] }> {
  const line = await bankLine(trx, orgId, txnId);
  await assertOpen(line);
  if (!picks.length) throw badRequest('Pick what the line is.');
  const seen = new Set<string>();
  for (const p of picks) {
    const k = `${p.type}:${p.id}`;
    if (seen.has(k)) throw badRequest('The same transaction is picked twice.');
    seen.add(k);
  }

  const pool = await candidatePool(trx, orgId, { id: line.bankAccountId, ledgerAccountId: line.ledgerAccountId }, line.direction);
  const byKey = new Map(pool.map((c) => [c.key, c]));
  const docs: { c: Candidate; amount: Paise }[] = [];
  const recorded: Candidate[] = [];
  for (const p of picks) {
    const c = byKey.get(`${p.type}:${p.id}`);
    if (!c) {
      throw badRequest(`That ${p.type} cannot be matched to this line: it is not open, is in the other direction, `
        + 'goes through another account, or another line is already matched to it.');
    }
    if (c.type === 'invoice' || c.type === 'bill') {
      const amount = p.amountPaise ?? c.amountPaise;
      if (amount <= 0) throw badRequest(`Give how much of ${c.number} this pays.`);
      if (amount > c.amountPaise) throw badRequest(`Only ${(c.amountPaise / 100).toFixed(2)} of ${c.number} is still owed.`);
      docs.push({ c, amount });
    } else recorded.push(c);
  }

  const total = docs.reduce((t, d) => t + d.amount, 0) + recorded.reduce((t, c) => t + c.amountPaise, 0);
  const difference = line.amountPaise - total;
  if (difference !== 0 && !opts.differenceAccountId) {
    throw new ApiError(409,
      `The line is ${(line.amountPaise / 100).toFixed(2)} and what you picked comes to ${(total / 100).toFixed(2)}. `
        + 'Say where the difference of ' + `${(Math.abs(difference) / 100).toFixed(2)} goes (bank charges, usually), or change the picks.`,
      'difference');
  }

  const links: LinkRow[] = [];
  const created: string[] = [];
  const branchId = await primaryBranch(trx, orgId);
  const mode = modeFromNarration(line.narration);
  const reference = (line.reference || line.narration).slice(0, 100);

  // One receipt (or payment) per party, set against all its picked documents.
  const byParty = new Map<string, { c: Candidate; amount: Paise }[]>();
  for (const d of docs) byParty.set(d.c.contactId!, [...(byParty.get(d.c.contactId!) ?? []), d]);
  for (const [contactId, list] of byParty) {
    const amount = list.reduce((t, d) => t + d.amount, 0);
    const allocations: AllocationInput[] = list.map((d) => ({ targetType: d.c.type as 'invoice' | 'bill', targetId: Number(d.c.id), amountPaise: d.amount }));
    const input = {
      branchId, contactId: Number(contactId), date: line.date, mode, amountPaise: amount, bankAccountId: line.bankAccountId,
      reference, allocations, notes: `Recorded from the bank statement: matched to ${list.map((d) => d.c.number).join(', ')}.`,
    };
    const pay = line.direction === 'in' ? await receivePayment(trx, orgId, userId, input) : await makePayment(trx, orgId, userId, input);
    links.push({ target_type: 'payment', target_id: pay.id, amount, created: true });
    created.push(pay.number);
  }
  for (const c of recorded) {
    links.push({ target_type: c.type === 'journal' ? 'journal_entry' : c.type as LinkRow['target_type'], target_id: Number(c.id), amount: c.amountPaise, created: false });
  }

  if (difference !== 0) {
    const acct = await trx.selectFrom('accounts').select(['id', 'name']).where('id', '=', opts.differenceAccountId!).where('org_id', '=', orgId).executeTakeFirst();
    if (!acct) throw notFound('That account does not exist.');
    // Money in, more than the picks: the extra is credited to the account; less (a charge taken): it is debited.
    const abs = Math.abs(difference);
    const towardsIn = line.direction === 'in' ? difference > 0 : difference < 0;
    const entryId = await postAgainstBank(trx, orgId, userId, line,
      [towardsIn ? { accountId: acct.id, credit: abs } : { accountId: acct.id, debit: abs }],
      `Difference on bank line ${line.date}: ${acct.name}`);
    links.push({ target_type: 'journal_entry', target_id: entryId, amount: abs, created: true });
  }

  await writeLinks(trx, orgId, userId, line, links);
  return { matched: links.length, created };
}

// ── Categorize Manually ──────────────────────────────────────────────────────

export interface CategoriseInput {
  category: BankCategoryKey;
  contactId?: number | null;
  /** Customer or vendor payments: the documents it settles. */
  allocations?: { targetId: number; amountPaise: Paise }[];
  bankChargesPaise?: Paise;
  tdsPaise?: Paise;
  /** Transfers and card payments: the account at the other end. */
  otherBankAccountId?: number | null;
  /** Journal and expense categories: the account it goes to. */
  accountId?: number | null;
  gstRatePct?: number | null;
  itcEligibility?: 'eligible' | 'ineligible' | 'capital_goods';
  /** Refunds: the payment whose unused amount is refunded. */
  paymentId?: number | null;
  reference?: string | null;
  notes?: string | null;
}

/** Categorise a line by one of Zoho's categories, posting what that category records. */
export async function categoriseAs(trx: Trx, orgId: number, userId: number | null, txnId: number, input: CategoriseInput): Promise<{ created: string | null }> {
  const line = await bankLine(trx, orgId, txnId);
  await assertOpen(line);
  const { link, created } = await postCategory(trx, orgId, userId, line, input);
  await writeLinks(trx, orgId, userId, line, [link]);
  return { created };
}

/**
 * Money in or out of a bank account: a statement line, or one typed in from
 * the account's "Add Transaction" (no statement line yet, so `id` is null and
 * nothing is linked; when the statement arrives, its line is matched to this).
 */
export type BankMoney = Omit<BankLine, 'status' | 'id'> & { id: number | null };

/** Record what a category records for this money, and say what it made. */
async function postCategory(trx: Trx, orgId: number, userId: number | null, line: BankMoney, input: CategoriseInput): Promise<{ link: LinkRow; created: string | null }> {
  const cat = categoryOf(input.category);
  if (!cat) throw badRequest('Choose a category.');
  if (cat.side !== line.direction) {
    throw badRequest(`${cat.label} is for money ${cat.side === 'in' ? 'in' : 'out'}, and this line is money ${line.direction}.`);
  }
  if (cat.contactRequired && !input.contactId) throw badRequest(`Choose the ${cat.contact === 'vendor' ? 'vendor' : 'customer'}.`);

  const branchId = await primaryBranch(trx, orgId);
  const reference = (input.reference?.trim() || line.reference || line.narration).slice(0, 100);
  const notes = input.notes?.trim() || `Categorised from the bank statement: ${line.narration}`.slice(0, 500);
  const mode = modeFromNarration(line.narration);
  let link: LinkRow;
  let createdNo: string | null = null;

  if (cat.engine === 'customer' || cat.engine === 'vendor') {
    const charges = input.bankChargesPaise ?? 0;
    const tds = input.tdsPaise ?? 0;
    if (charges < 0 || tds < 0) throw badRequest('Bank charges and TDS cannot be below zero.');
    // A receipt lands less the charge; a payment leaves plus it. Either way the bank moves by the line.
    const amount = cat.engine === 'customer' ? line.amountPaise + charges : line.amountPaise - charges;
    if (amount <= 0) throw badRequest('The bank charges are more than the line.');
    const advance = cat.key === 'customer_advance' || cat.key === 'vendor_advance';
    const allocations: AllocationInput[] = advance ? [] : (input.allocations ?? []).filter((a) => a.amountPaise > 0)
      .map((a) => ({ targetType: cat.engine === 'customer' ? 'invoice' : 'bill', targetId: a.targetId, amountPaise: a.amountPaise }));
    const payInput = {
      branchId, contactId: input.contactId!, date: line.date, mode, amountPaise: amount, bankAccountId: line.bankAccountId,
      reference, tdsPaise: tds, bankChargesPaise: charges, allocations, notes,
    };
    const pay = cat.engine === 'customer' ? await receivePayment(trx, orgId, userId, payInput) : await makePayment(trx, orgId, userId, payInput);
    link = { target_type: 'payment', target_id: pay.id, amount: line.amountPaise, created: true, category: cat.key };
    createdNo = pay.number;
  } else if (cat.engine === 'transfer') {
    if (!input.otherBankAccountId) throw badRequest(cat.otherAccount === 'card' ? 'Choose the credit card.' : 'Choose the other account.');
    if (input.otherBankAccountId === line.bankAccountId) throw badRequest('Choose a different account from this one.');
    if (cat.otherAccount === 'card') {
      const other = await trx.selectFrom('bank_accounts').select('kind').where('id', '=', input.otherBankAccountId).where('org_id', '=', orgId).executeTakeFirst();
      if (other?.kind !== 'card') throw badRequest('A card payment goes to a credit card account.');
    }
    const t = await createTransfer(trx, orgId, userId, {
      fromBankAccountId: line.direction === 'in' ? input.otherBankAccountId : line.bankAccountId,
      toBankAccountId: line.direction === 'in' ? line.bankAccountId : input.otherBankAccountId,
      date: line.date, amountPaise: line.amountPaise, reference,
    });
    link = { target_type: 'transfer', target_id: t.id, amount: line.amountPaise, created: true, category: cat.key };
  } else if (cat.engine === 'expense') {
    if (!input.accountId) throw badRequest('Choose the expense account.');
    const exp = await createExpense(trx, orgId, userId, {
      branchId, date: line.date, accountId: input.accountId, paidThroughBankAccountId: line.bankAccountId,
      amountPaise: line.amountPaise, gstRatePct: input.gstRatePct ?? 0, vendorId: input.contactId ?? null,
      itcEligibility: input.itcEligibility, reference, notes,
    });
    link = { target_type: 'expense', target_id: exp.id, amount: line.amountPaise, created: true, category: cat.key };
    createdNo = exp.number;
  } else if (cat.engine === 'refund') {
    // An advance returned: what is left unused on that payment goes down, and so does the party's credit.
    if (!input.paymentId) throw badRequest('Choose the payment whose advance is refunded.');
    const kind = cat.key === 'payment_refund' ? 'received' : 'made';
    const pay = await trx.selectFrom('payments').select(['id', 'number', 'kind', 'contact_id', 'unapplied_amount', 'status'])
      .where('id', '=', input.paymentId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
    if (!pay || pay.kind !== kind || pay.status === 'void') throw notFound('That payment cannot be refunded here.');
    if (input.contactId && pay.contact_id !== input.contactId) throw badRequest(`${pay.number} is another party's.`);
    const unused = toPaiseFromSql(pay.unapplied_amount);
    if (line.amountPaise > unused) throw badRequest(`Only ${(unused / 100).toFixed(2)} of ${pay.number} is unused, less than the line.`);
    const acc = await accountIds(trx, orgId);
    const control = kind === 'received' ? requireAccount(acc, CODE.AR) : requireAccount(acc, CODE.AP);
    const entryId = await postAgainstBank(trx, orgId, userId, line,
      [kind === 'received'
        ? { accountId: control, debit: line.amountPaise, contactId: pay.contact_id, description: `Refund of ${pay.number}` }
        : { accountId: control, credit: line.amountPaise, contactId: pay.contact_id, description: `Refund of ${pay.number}` }],
      `${cat.label}: ${pay.number}`);
    await trx.updateTable('payments').set({ unapplied_amount: toSqlFromPaise(unused - line.amountPaise) }).where('id', '=', pay.id).execute();
    link = { target_type: 'journal_entry', target_id: entryId, amount: line.amountPaise, created: true, category: cat.key, refundedPaymentId: pay.id };
  } else {
    if (!input.accountId) throw badRequest('Choose the account.');
    const acct = await trx.selectFrom('accounts').select(['id', 'name', 'type', 'code']).where('id', '=', input.accountId).where('org_id', '=', orgId).executeTakeFirst();
    if (!acct) throw notFound('That account does not exist.');
    if (cat.accountTypes && !cat.accountTypes.includes(acct.type as never)) throw badRequest(`${acct.name} is not an account ${cat.label} can go to.`);
    if (acct.code === CODE.AR || acct.code === CODE.AP) {
      throw badRequest('Receivables and payables come from invoices and bills: use Customer Payment or Vendor Payment.');
    }
    const lines: DraftLine[] = [];
    const rate = cat.tax ? input.gstRatePct ?? 0 : 0;
    const sign = line.direction === 'in' ? -1 : 1; // money in credits the account; money out debits it
    const side = (accountId: number, paise: Paise, extra: Partial<DraftLine> = {}): DraftLine =>
      sign < 0 ? { accountId, credit: paise, ...extra } : { accountId, debit: paise, ...extra };
    if (rate > 0) {
      // The line includes the tax: a sale without an invoice owes GST on its share.
      const taxable = Math.round((line.amountPaise * 100) / (100 + rate));
      const tax = line.amountPaise - taxable;
      const branch = await trx.selectFrom('branches').select('state_code').where('id', '=', branchId).executeTakeFirstOrThrow();
      const party = input.contactId
        ? await trx.selectFrom('contacts').select('state_code').where('id', '=', input.contactId).where('org_id', '=', orgId).executeTakeFirst()
        : null;
      const acc = await accountIds(trx, orgId);
      lines.push(side(acct.id, taxable, { contactId: input.contactId ?? null }));
      if (!party || party.state_code === branch.state_code) {
        const sgst = Math.floor(tax / 2);
        lines.push(side(requireAccount(acc, CODE.GST_CGST), tax - sgst, { description: `CGST ${rate / 2}%` }));
        if (sgst) lines.push(side(requireAccount(acc, CODE.GST_SGST), sgst, { description: `SGST ${rate / 2}%` }));
      } else {
        lines.push(side(requireAccount(acc, CODE.GST_IGST), tax, { description: `IGST ${rate}%` }));
      }
    } else {
      lines.push(side(acct.id, line.amountPaise, { contactId: input.contactId ?? null, description: input.notes?.slice(0, 200) ?? null }));
    }
    const entryId = await postAgainstBank(trx, orgId, userId, line, lines, `${cat.label}: ${input.notes?.trim() || line.narration}`);
    link = { target_type: 'journal_entry', target_id: entryId, amount: line.amountPaise, created: true, category: cat.key };
  }

  return { link, created: createdNo };
}

/**
 * Zoho's "Add Transaction" on a bank account: an expense, a transfer, a
 * deposit, a refund … recorded straight from the account, before (or without)
 * a statement line, through the same postings as categorising a line would.
 */
export async function addBankTransaction(
  trx: Trx, orgId: number, userId: number | null, bankAccountId: number,
  input: CategoriseInput & { date: string; amountPaise: Paise },
): Promise<{ created: string | null; targetType: LinkRow['target_type']; targetId: number }> {
  const cat = categoryOf(input.category);
  if (!cat) throw badRequest('Choose what the transaction is.');
  if (!(input.amountPaise > 0)) throw badRequest('Enter an amount above zero.');
  const bank = await trx.selectFrom('bank_accounts').select(['id', 'name', 'ledger_account_id', 'is_active'])
    .where('id', '=', bankAccountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!bank) throw notFound('That account does not exist.');
  if (!bank.is_active) throw badRequest(`${bank.name} is inactive. Mark it as active first.`);
  const money: BankMoney = {
    id: null, date: input.date, amountPaise: input.amountPaise, direction: cat.side,
    narration: (input.notes?.trim() || cat.label).slice(0, 200), reference: input.reference?.trim() || null,
    bankAccountId: bank.id, ledgerAccountId: bank.ledger_account_id, bankName: bank.name,
  };
  const { link, created } = await postCategory(trx, orgId, userId, money, input);
  return { created, targetType: link.target_type, targetId: link.target_id };
}

// ── Undoing ──────────────────────────────────────────────────────────────────

/**
 * Take back what matching or categorising did to a line, if it went through
 * the links. Returns false for a line matched the older way (banking.ts deals
 * with it). What the match created is voided or reversed; what was already in
 * the books is only let go.
 */
export async function undoLinks(trx: Trx, orgId: number, userId: number | null, txnId: number): Promise<boolean> {
  const links = await trx.selectFrom('bank_transaction_links').selectAll()
    .where('org_id', '=', orgId).where('bank_transaction_id', '=', txnId).orderBy('id', 'desc').execute();
  if (!links.length) return false;
  for (const l of links) {
    if (!l.created_by_match) continue;
    if (l.target_type === 'payment') {
      await voidPayment(trx, orgId, userId, l.target_id, 'Bank line unmatched: the receipt or payment it recorded is taken back');
    } else if (l.target_type === 'expense') {
      const e = await trx.selectFrom('expenses').select(['id', 'status', 'journal_entry_id']).where('id', '=', l.target_id).where('org_id', '=', orgId).executeTakeFirst();
      if (e && e.status !== 'void') {
        if (e.journal_entry_id) await reverseEntry(trx, orgId, e.journal_entry_id, { memo: 'Bank line uncategorised', userId, module: 'banking' });
        await trx.updateTable('expenses').set({ status: 'void' }).where('id', '=', e.id).execute();
      }
    } else if (l.target_type === 'transfer') {
      const x = await trx.selectFrom('bank_transfers').select(['id', 'journal_entry_id']).where('id', '=', l.target_id).where('org_id', '=', orgId).executeTakeFirst();
      if (x) {
        if (x.journal_entry_id) await reverseEntry(trx, orgId, x.journal_entry_id, { memo: 'Bank line uncategorised', userId, module: 'banking' });
        await trx.deleteFrom('bank_transfers').where('id', '=', x.id).execute();
      }
    } else if (l.target_type === 'journal_entry') {
      await reverseEntry(trx, orgId, l.target_id, { memo: 'Bank line unmatched', userId, module: 'banking' });
      if (l.refunded_payment_id) {
        await trx.updateTable('payments')
          .set((eb) => ({ unapplied_amount: eb('unapplied_amount', '+', l.amount) }))
          .where('id', '=', l.refunded_payment_id).execute();
      }
    }
  }
  await trx.deleteFrom('bank_transaction_links').where('bank_transaction_id', '=', txnId).execute();
  await trx.updateTable('bank_transactions')
    .set({ status: 'unmatched', matched_type: null, matched_id: null, matched_at: null })
    .where('id', '=', txnId).execute();
  return true;
}

/** What a matched line is matched to, in words, for the Categorized tab. */
export async function linksOf(ex: Executor, orgId: number, txnId: number): Promise<{
  type: string; id: string; label: string; amountPaise: Paise; created: boolean; category: string | null;
}[]> {
  const t = await ex.selectFrom('bank_transactions').select(['matched_type', 'matched_id']).where('id', '=', txnId).where('org_id', '=', orgId).executeTakeFirst();
  if (!t) throw notFound('That bank line does not exist.');
  const links = await ex.selectFrom('bank_transaction_links').selectAll().where('bank_transaction_id', '=', txnId).where('org_id', '=', orgId).orderBy('id').execute();
  const rows = links.length
    ? links.map((l) => ({ type: l.target_type, id: l.target_id, amount: toPaiseFromSql(l.amount), created: !!l.created_by_match, category: l.category }))
    : t.matched_type && t.matched_id ? [{ type: t.matched_type, id: t.matched_id, amount: 0, created: t.matched_type === 'journal_entry', category: null }] : [];
  const out = [];
  for (const r of rows) {
    let label = `${r.type} ${r.id}`;
    if (r.type === 'payment') {
      const p = await ex.selectFrom('payments as p').innerJoin('contacts as c', 'c.id', 'p.contact_id').select(['p.number', 'p.kind', 'c.display_name', 'p.amount'])
        .where('p.id', '=', r.id).executeTakeFirst();
      if (p) label = `${p.kind === 'received' ? 'Customer payment' : 'Vendor payment'} ${p.number} · ${p.display_name}`;
      if (p && !r.amount) r.amount = toPaiseFromSql(p.amount);
    } else if (r.type === 'expense') {
      const e = await ex.selectFrom('expenses as e').innerJoin('accounts as a', 'a.id', 'e.account_id').select(['e.number', 'a.name']).where('e.id', '=', r.id).executeTakeFirst();
      if (e) label = `Expense ${e.number} · ${e.name}`;
    } else if (r.type === 'transfer') {
      const x = await ex.selectFrom('bank_transfers as x').innerJoin('bank_accounts as f', 'f.id', 'x.from_bank_account_id').innerJoin('bank_accounts as to', 'to.id', 'x.to_bank_account_id')
        .select(['f.name as from_name', 'to.name as to_name']).where('x.id', '=', r.id).executeTakeFirst();
      if (x) label = `Transfer ${x.from_name} → ${x.to_name}`;
    } else if (r.type === 'journal_entry') {
      const e = await ex.selectFrom('journal_entries').select(['entry_no', 'memo']).where('id', '=', r.id).executeTakeFirst();
      if (e) label = `Journal ${e.entry_no}${e.memo ? ` · ${e.memo}` : ''}`;
    }
    out.push({ type: r.type, id: String(r.id), label, amountPaise: r.amount, created: r.created, category: r.category ?? null });
  }
  return out;
}

/** Zoho's "Add Transaction" entries that are not a line category: a credit note's refund, a retainer's payment. */
export type AddTransactionKind = BankCategoryKey | 'credit_note_refund' | 'retainer_payment';

/**
 * Everything on Zoho's "Add Transaction ▾" menu for a bank account:
 * MONEY OUT — Expense, Transfer To Another Account, Credit Note Refund, Payment
 * Refund; MONEY IN — Customer Payment, Retainer Payment, Transfer From Another
 * Account, Expense Refund, Deposit From Other Accounts (and the rest of the
 * categories a line can be). A credit note's refund goes through the credit
 * note (sales-documents.ts), so its balance comes down; a retainer's payment
 * is a receipt set against the retainer.
 */
export async function addAccountTransaction(
  trx: Trx, orgId: number, userId: number | null, bankAccountId: number,
  input: Omit<CategoriseInput, 'category'> & { kind: AddTransactionKind; date: string; amountPaise: Paise; creditNoteId?: number | null; retainerId?: number | null },
): Promise<{ created: string | null }> {
  if (input.kind === 'credit_note_refund') {
    if (!input.creditNoteId) throw badRequest('Choose the credit note to refund.');
    const { refundCreditNote } = await import('./sales-documents');
    const r = await refundCreditNote(trx, orgId, userId, input.creditNoteId, {
      bankAccountId, date: input.date, amountPaise: input.amountPaise, reference: input.reference ?? null,
    });
    const cn = await trx.selectFrom('credit_notes').select('number').where('id', '=', input.creditNoteId).executeTakeFirst();
    return { created: cn ? `${cn.number} refund (${(r.refundedPaise / 100).toFixed(2)})` : null };
  }
  if (input.kind === 'retainer_payment') {
    if (!input.contactId) throw badRequest('Choose the customer.');
    if (!input.retainerId) throw badRequest('Choose the retainer invoice.');
    if (!(input.amountPaise > 0)) throw badRequest('Enter an amount above zero.');
    const bank = await trx.selectFrom('bank_accounts').select(['id', 'name']).where('id', '=', bankAccountId).where('org_id', '=', orgId).executeTakeFirst();
    if (!bank) throw notFound('That account does not exist.');
    const pay = await receivePayment(trx, orgId, userId, {
      branchId: await primaryBranch(trx, orgId), contactId: input.contactId, date: input.date, mode: modeFromNarration(input.reference ?? ''),
      amountPaise: input.amountPaise, bankAccountId, reference: input.reference ?? null, notes: input.notes ?? null,
      allocations: [{ targetType: 'retainer', targetId: input.retainerId, amountPaise: input.amountPaise }],
    });
    return { created: pay.number };
  }
  const r = await addBankTransaction(trx, orgId, userId, bankAccountId, { ...input, category: input.kind });
  return { created: r.created };
}

/**
 * Zoho's Multi-Select & Match: several statement lines of one account that
 * together are one transaction already in the books — two deposits a bank
 * split, a payment that left in parts. Each line is linked to that one
 * transaction for its own amount, and nothing is posted: the transaction
 * posted when it was entered. The lines must add up to it exactly, or the
 * match is refused, because a match that hides a difference is worse than none.
 */
export async function matchLinesTogether(
  trx: Trx, orgId: number, userId: number | null, txnIds: number[], target: { type: 'payment' | 'expense' | 'transfer' | 'journal'; id: number },
): Promise<{ matched: number }> {
  const ids = [...new Set(txnIds)];
  if (ids.length < 2) throw badRequest('Choose two or more statement lines to match together.');
  const lines = await Promise.all(ids.map((id) => bankLine(trx, orgId, id)));
  for (const l of lines) await assertOpen(l);
  const first = lines[0];
  if (lines.some((l) => l.bankAccountId !== first.bankAccountId)) throw badRequest('The lines are from different accounts.');
  if (lines.some((l) => l.direction !== first.direction)) throw badRequest('Choose only deposits, or only withdrawals.');
  const pool = await candidatePool(trx, orgId, { id: first.bankAccountId, ledgerAccountId: first.ledgerAccountId }, first.direction);
  const hit = pool.find((c) => c.type === target.type && Number(c.id) === target.id);
  if (!hit) throw badRequest('That transaction is not open to match: it may already be matched, or be in another account.');
  const total = lines.reduce((t, l) => t + l.amountPaise, 0);
  if (total !== hit.amountPaise) {
    throw badRequest(`The lines add up to ${(total / 100).toFixed(2)} and ${hit.number} is ${(hit.amountPaise / 100).toFixed(2)}. They have to be the same.`);
  }
  const targetType = target.type === 'journal' ? 'journal_entry' : target.type;
  for (const l of lines) {
    await writeLinks(trx, orgId, userId, l, [{ target_type: targetType, target_id: target.id, amount: l.amountPaise, created: false }]);
  }
  return { matched: lines.length };
}

/** What several lines of an account could be matched to together: recorded transactions no line has claimed. */
export async function recordedCandidates(ex: Executor, orgId: number, bankAccountId: number, direction: 'in' | 'out'): Promise<Candidate[]> {
  const bank = await ex.selectFrom('bank_accounts').select(['id', 'ledger_account_id']).where('id', '=', bankAccountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!bank) throw notFound('That account does not exist.');
  const pool = await candidatePool(ex, orgId, { id: bank.id, ledgerAccountId: bank.ledger_account_id }, direction);
  return pool.filter((c) => c.type !== 'invoice' && c.type !== 'bill').sort((a, b) => b.date.localeCompare(a.date));
}
