import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Opening balances: what the business already had on the day these books
// start.
//
// Three kinds, entered three ways, all against Opening Balance Equity (3300):
//
//   * ledger accounts: one figure each, posted as a dated entry. Changing a
//     figure posts the difference rather than editing what is there, so the
//     trail shows what was entered and when.
//   * customers and vendors: their unpaid bills one by one, so each ages from
//     its own due date and can be paid off like any invoice or bill.
//   * stock: the quantity and rate on each item. Not posted; the statements
//     value it, as they value closing stock.
//
// When everything is in, what is left in 3300 is the opening stock and
// nothing else. Anything more is the "difference in opening balances" a
// migration has to explain before the books can be relied on.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { postEntry, reverseEntry, type DraftLine } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { badRequest, conflict, notFound } from '../http';
import { voidReason, voidStamp } from './void-reason';
import { stockPosition } from '../reports/stock';

/** Entries that carry opening figures, whichever screen made them. */
export const OPENING_SOURCES = ['opening', 'opening_balance', 'opening_document'] as const;

/** Accounts whose openings come from somewhere other than a ledger figure. */
const NOT_ENTERED_HERE: Record<string, string> = {
  [CODE.AR]: 'Entered customer by customer, bill by bill.',
  [CODE.AP]: 'Entered vendor by vendor, bill by bill.',
  [CODE.OPENING_BALANCE_EQUITY]: 'The balancing account; it is never entered.',
  [CODE.INVENTORY]: 'Opening stock is the quantity and rate on each item.',
  [CODE.CWIP]: 'Entered asset by asset in the fixed-asset register.',
  [CODE.ACCUMULATED_DEPRECIATION]: 'Entered asset by asset in the fixed-asset register, with what was written off each.',
};
const IN_REGISTER = 'Entered asset by asset in the fixed-asset register, so each one is depreciated.';

function fyStartFor(today: string, startMonth: number) {
  const [y, m] = today.split('-').map(Number);
  const year = m >= startMonth ? y : y - 1;
  return `${year}-${String(startMonth).padStart(2, '0')}-01`;
}

/** The day the books start. Until someone sets it, the start of this financial year. */
export async function booksStartDate(ex: Executor, orgId: number): Promise<{ date: string; isSet: boolean }> {
  const org = await ex.selectFrom('organizations').select(['books_start_date', 'fiscal_year_start_month'])
    .where('id', '=', orgId).executeTakeFirstOrThrow();
  if (org.books_start_date) return { date: String(org.books_start_date).slice(0, 10), isSet: true };
  // A book that already has openings started where they were dated.
  const first = await ex.selectFrom('journal_entries').select(sql<string>`MIN(entry_date)`.as('d'))
    .where('org_id', '=', orgId).where('source_type', 'in', [...OPENING_SOURCES]).executeTakeFirst();
  if (first?.d) return { date: String(first.d).slice(0, 10), isSet: false };
  return { date: fyStartFor(new Date().toISOString().slice(0, 10), org.fiscal_year_start_month ?? 4), isSet: false };
}

export async function setBooksStartDate(trx: Trx, orgId: number, date: string) {
  const { date: current } = await booksStartDate(trx, orgId);
  const posted = await trx.selectFrom('journal_entries').select('id')
    .where('org_id', '=', orgId).where('source_type', 'in', [...OPENING_SOURCES]).executeTakeFirst();
  if (posted && date !== current) {
    throw conflict(
      `Opening balances are already posted on ${current}. Moving the start date would leave them on the wrong ` +
        'day; set it before entering them.',
    );
  }
  const earlier = await trx.selectFrom('journal_entries').select(['entry_date'])
    .where('org_id', '=', orgId).where('entry_date', '<', date)
    .where('source_type', 'not in', [...OPENING_SOURCES]).orderBy('entry_date').limit(1).executeTakeFirst();
  if (earlier) {
    throw badRequest(`There are entries dated ${String(earlier.entry_date).slice(0, 10)}, before ${date}. The books cannot start after their first entry.`);
  }
  await trx.updateTable('organizations').set({ books_start_date: date }).where('id', '=', orgId).execute();
}

export interface OpeningAccountRow {
  accountId: string;
  code: string;
  name: string;
  type: string;
  /** Net opening: debit positive, credit negative. */
  netPaise: Paise;
  /** Null when it can be entered here; otherwise where it comes from. */
  lockedReason: string | null;
}

export interface OpeningSummary {
  startDate: string;
  startDateSet: boolean;
  accounts: OpeningAccountRow[];
  receivablesPaise: Paise;
  payablesPaise: Paise;
  stockPaise: Paise;
  /** What 3300 holds, debit positive. */
  equityBalancePaise: Paise;
  /**
   * Zero when the openings agree: 3300 then holds exactly the opening stock.
   * Below zero, the figures entered have more debit than credit; above, more credit.
   */
  differencePaise: Paise;
}

export async function openingSummary(ex: Executor, orgId: number): Promise<OpeningSummary> {
  const start = await booksStartDate(ex, orgId);
  const [accounts, nets, banks, parties, stock, classLedgers] = await Promise.all([
    ex.selectFrom('accounts').select(['id', 'code', 'name', 'type'])
      .where('org_id', '=', orgId).where('is_active', '=', 1).orderBy('code').execute(),
    sql<{ account_id: number; net: string }>`
      SELECT jl.account_id, SUM(jl.debit - jl.credit) AS net
        FROM journal_lines jl JOIN journal_entries e ON e.id = jl.entry_id
       WHERE e.org_id = ${orgId} AND e.source_type IN ('opening', 'opening_balance', 'opening_document')
       GROUP BY jl.account_id
    `.execute(ex),
    ex.selectFrom('bank_accounts').select(['ledger_account_id', 'name']).where('org_id', '=', orgId).execute(),
    sql<{ kind: string; owed: string }>`
      SELECT kind, COALESCE(SUM(amount), 0) AS owed
        FROM opening_documents WHERE org_id = ${orgId} AND status <> 'void' GROUP BY kind
    `.execute(ex),
    stockPosition(ex, orgId, start.date),
    ex.selectFrom('asset_classes').select('account_id').where('org_id', '=', orgId).execute(),
  ]);

  const net = new Map(nets.rows.map((r) => [Number(r.account_id), toPaiseFromSql(r.net)]));
  const bankLedgers = new Map(banks.map((b) => [b.ledger_account_id, b.name]));
  const assetLedgers = new Set(classLedgers.map((c) => c.account_id));
  const rows: OpeningAccountRow[] = accounts.map((a) => ({
    accountId: String(a.id),
    code: a.code,
    name: a.name,
    type: a.type,
    netPaise: net.get(a.id) ?? 0,
    lockedReason: NOT_ENTERED_HERE[a.code]
      ?? (bankLedgers.has(a.id) ? `The ledger of bank account ${bankLedgers.get(a.id)}; its opening is set on the account in Banking.` : null)
      ?? (assetLedgers.has(a.id) ? IN_REGISTER : null),
  }));

  const equity = net.get(accounts.find((a) => a.code === CODE.OPENING_BALANCE_EQUITY)?.id ?? -1) ?? 0;
  const stockPaise = stock.bookOpeningValuePaise;
  const owed = (k: string) => toPaiseFromSql(parties.rows.find((r) => r.kind === k)?.owed ?? '0');
  return {
    startDate: start.date,
    startDateSet: start.isSet,
    accounts: rows,
    receivablesPaise: owed('receivable'),
    payablesPaise: owed('payable'),
    stockPaise,
    equityBalancePaise: equity,
    differencePaise: equity - stockPaise,
  };
}

/**
 * Set ledger openings. `lines` gives the opening each named account should
 * have; accounts not named are left as they are. What is posted is the
 * difference from what is there now, balanced against 3300.
 */
export async function setAccountOpenings(
  trx: Trx, orgId: number, userId: number | null,
  input: { branchId: number; lines: { accountId: number; netPaise: Paise }[] },
): Promise<{ entryId: number | null; changed: number }> {
  const summary = await openingSummary(trx, orgId);
  const byId = new Map(summary.accounts.map((a) => [Number(a.accountId), a]));
  const acc = await accountIds(trx, orgId);

  const draft: DraftLine[] = [];
  let net = 0;
  for (const l of input.lines) {
    const a = byId.get(l.accountId);
    if (!a) throw notFound(`Account ${l.accountId} is not in this book.`);
    if (a.lockedReason) throw badRequest(`${a.code} ${a.name}: ${a.lockedReason}`);
    const delta = l.netPaise - a.netPaise;
    if (delta === 0) continue;
    draft.push(delta > 0
      ? { accountId: l.accountId, debit: delta, description: 'Opening balance' }
      : { accountId: l.accountId, credit: -delta, description: 'Opening balance' });
    net += delta;
  }
  if (!draft.length) return { entryId: null, changed: 0 };

  const equity = requireAccount(acc, CODE.OPENING_BALANCE_EQUITY);
  draft.push(net > 0 ? { accountId: equity, credit: net } : { accountId: equity, debit: -net });

  const anyBefore = summary.accounts.some((a) => !a.lockedReason && a.netPaise !== 0);
  const entry = await postEntry(trx, {
    orgId, branchId: input.branchId, date: summary.startDate,
    memo: anyBefore ? 'Opening balances changed' : 'Opening balances',
    sourceType: 'opening', userId, lines: draft,
  });
  if (!summary.startDateSet) {
    await trx.updateTable('organizations').set({ books_start_date: summary.startDate }).where('id', '=', orgId).execute();
  }
  return { entryId: entry.id, changed: draft.length - 1 };
}

// ── Customers' and vendors' opening bills ────────────────────────────────────

export interface OpeningDocumentInput {
  branchId: number;
  contactId: number;
  kind: 'receivable' | 'payable';
  refNo: string;
  docDate: string;
  dueDate: string;
  amountPaise: Paise;
  notes?: string | null;
}

export async function addOpeningDocument(trx: Trx, orgId: number, userId: number | null, input: OpeningDocumentInput) {
  if (!(input.amountPaise > 0)) throw badRequest('An opening bill needs an amount above zero.');
  const contact = await trx.selectFrom('contacts').select(['id', 'display_name', 'kind'])
    .where('id', '=', input.contactId).where('org_id', '=', orgId).executeTakeFirst();
  if (!contact) throw notFound('That contact does not exist.');

  const start = await booksStartDate(trx, orgId);
  if (input.docDate >= start.date) {
    throw badRequest(
      `An opening bill is one raised before the books start on ${start.date}. ` +
        `Enter ${input.refNo} as an ${input.kind === 'receivable' ? 'invoice' : 'bill'} instead.`,
    );
  }
  if (input.dueDate < input.docDate) throw badRequest('The due date cannot be before the bill date.');

  const id = Number((await trx.insertInto('opening_documents').values({
    org_id: orgId, branch_id: input.branchId, contact_id: input.contactId, kind: input.kind,
    ref_no: input.refNo.trim(), doc_date: input.docDate, due_date: input.dueDate,
    amount: toSqlFromPaise(input.amountPaise), notes: input.notes ?? null, created_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);

  const acc = await accountIds(trx, orgId);
  const equity = requireAccount(acc, CODE.OPENING_BALANCE_EQUITY);
  const description = `${input.refNo} of ${input.docDate}`;
  const lines: DraftLine[] = input.kind === 'receivable'
    ? [
        { accountId: requireAccount(acc, CODE.AR), debit: input.amountPaise, contactId: input.contactId, description },
        { accountId: equity, credit: input.amountPaise },
      ]
    : [
        { accountId: equity, debit: input.amountPaise },
        { accountId: requireAccount(acc, CODE.AP), credit: input.amountPaise, contactId: input.contactId, description },
      ];
  // Dated the day the books start, whatever the bill's own date: the books
  // hold nothing earlier. The bill's date and due date drive its ageing.
  const entry = await postEntry(trx, {
    orgId, branchId: input.branchId, date: start.date,
    memo: `Opening ${input.kind === 'receivable' ? 'receivable' : 'payable'}: ${contact.display_name}, ${input.refNo}`,
    sourceType: 'opening_document', sourceId: id, userId, lines,
  });
  await trx.updateTable('opening_documents').set({ journal_entry_id: entry.id }).where('id', '=', id).execute();
  if (!start.isSet) {
    await trx.updateTable('organizations').set({ books_start_date: start.date }).where('id', '=', orgId).execute();
  }
  return { id, journalEntryId: entry.id };
}

/** Withdraw an opening bill entered by mistake. Only while nothing has been paid against it. */
export async function voidOpeningDocument(trx: Trx, orgId: number, userId: number | null, id: number, reason?: string) {
  const d = await trx.selectFrom('opening_documents').selectAll()
    .where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!d) throw notFound('That opening bill was not found.');
  if (d.status === 'void') throw conflict('It is already withdrawn.');
  if (toPaiseFromSql(d.amount_paid) > 0) {
    throw conflict(`${d.ref_no} has been paid against. Undo those payments first.`);
  }
  const why = voidReason(reason);
  if (d.journal_entry_id) {
    await reverseEntry(trx, orgId, d.journal_entry_id, { memo: `Opening bill ${d.ref_no} withdrawn — ${why}`, userId });
  }
  await trx.updateTable('opening_documents').set({ status: 'void', ...voidStamp(why, userId) }).where('id', '=', id).execute();
}

export interface OpeningDocumentRow {
  id: string;
  contactId: string;
  contactName: string;
  kind: 'receivable' | 'payable';
  refNo: string;
  docDate: string;
  dueDate: string;
  amountPaise: Paise;
  amountPaidPaise: Paise;
  balancePaise: Paise;
  status: string;
}

export async function listOpeningDocuments(
  ex: Executor, orgId: number, f: { contactId?: number; kind?: 'receivable' | 'payable'; open?: boolean } = {},
): Promise<OpeningDocumentRow[]> {
  const rows = await ex.selectFrom('opening_documents as d')
    .innerJoin('contacts as c', 'c.id', 'd.contact_id')
    .select(['d.id', 'd.contact_id', 'c.display_name', 'd.kind', 'd.ref_no', 'd.doc_date', 'd.due_date', 'd.amount', 'd.amount_paid', 'd.status'])
    .where('d.org_id', '=', orgId)
    .$if(!!f.contactId, (q) => q.where('d.contact_id', '=', f.contactId!))
    .$if(!!f.kind, (q) => q.where('d.kind', '=', f.kind!))
    .$if(!!f.open, (q) => q.where('d.status', 'in', ['open', 'partially_paid']))
    .orderBy('c.display_name').orderBy('d.due_date').orderBy('d.id')
    .execute();
  return rows.map((r) => ({
    id: String(r.id),
    contactId: String(r.contact_id),
    contactName: r.display_name,
    kind: r.kind,
    refNo: r.ref_no,
    docDate: String(r.doc_date).slice(0, 10),
    dueDate: String(r.due_date).slice(0, 10),
    amountPaise: toPaiseFromSql(r.amount),
    amountPaidPaise: toPaiseFromSql(r.amount_paid),
    balancePaise: toPaiseFromSql(r.amount) - toPaiseFromSql(r.amount_paid),
    status: r.status,
  }));
}
