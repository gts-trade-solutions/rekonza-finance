import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Zoho Books' Banking Overview and a bank account's page, from the books.
//
// Every figure has one source, as the rest of banking does:
// - "Amount in Zoho Books" (here, in the books) is what has been posted to the
//   account's ledger account — never a stored balance;
// - "Amount in Bank" is what the bank last said: the running balance on the
//   latest statement line imported, or nothing when no statement carried one;
// - "Uncategorized" counts statement lines nobody has matched or categorised.
// The chart is the same ledger balance taken at the end of each day (Last 30
// days) or each month (Last 12 months), per kind of account, as Zoho draws it.
//
// Who may see an account: Zoho's "Users" on the account. None chosen means
// everyone with the banking right; an admin always sees every account.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import { notFound } from '../http';
import { toPaiseFromSql } from '../money-sql';
import type { Paise, RoleName } from '../../types';
import { istDate } from '../ai/time';

export type AccountKind = 'bank' | 'card' | 'cash' | 'wallet' | 'clearing';
/** Zoho's four tiles, and which kinds of account each adds up. */
export const TILE_KINDS = {
  bank: ['bank'], card: ['card'], cash: ['cash', 'wallet'], clearing: ['clearing'],
} as const satisfies Record<string, AccountKind[]>;
export type TileKey = keyof typeof TILE_KINDS;

export interface Viewer { userId: number; role: RoleName }

export interface BankAccountFigures {
  id: number;
  kind: AccountKind;
  name: string;
  code: string | null;
  currency: string;
  accountNumber: string | null;
  accountLast4: string | null;
  bankName: string | null;
  ifsc: string | null;
  description: string | null;
  userIds: number[] | null;
  isPrimary: boolean;
  isActive: boolean;
  ledgerAccountId: number;
  uncategorized: number;
  amountInBooksPaise: Paise;
  /** The bank's own balance on the latest statement line, if a statement gave one. */
  amountInBankPaise: Paise | null;
  amountInBankOn: string | null;
}

const ids = (v: unknown): number[] | null => {
  const raw = typeof v === 'string' ? JSON.parse(v) : v;
  return Array.isArray(raw) && raw.length ? raw.map(Number).filter(Number.isFinite) : null;
};

/** Whether a user may see an account, by its Users setting. */
export function canSeeAccount(a: { userIds: number[] | null }, viewer: Viewer | null): boolean {
  if (!viewer || viewer.role === 'admin' || !a.userIds) return true;
  return a.userIds.includes(viewer.userId);
}

/** The accounts with their figures, as the overview's table and the account switcher show them. */
export async function accountsWithFigures(
  ex: Executor, orgId: number, opts: { status?: 'active' | 'inactive' | 'all'; viewer?: Viewer | null } = {},
): Promise<BankAccountFigures[]> {
  const status = opts.status ?? 'active';
  const { rows } = await sql<{
    id: number; kind: AccountKind; name: string; account_code: string | null; currency: string; account_number: string | null;
    account_last4: string | null; bank_name: string | null; ifsc: string | null; description: string | null; user_ids: unknown;
    is_primary: number; is_active: number; ledger_account_id: number; movement: string; unmatched: number;
    bank_balance: string | null; bank_balance_on: string | null;
  }>`
    SELECT ba.id, ba.kind, ba.name, ba.account_code, ba.currency, ba.account_number, ba.account_last4, ba.bank_name, ba.ifsc,
           ba.description, ba.user_ids, ba.is_primary, ba.is_active, ba.ledger_account_id,
           COALESCE((SELECT SUM(jl.debit - jl.credit) FROM journal_lines jl WHERE jl.account_id = ba.ledger_account_id), 0) AS movement,
           (SELECT COUNT(*) FROM bank_transactions bt WHERE bt.bank_account_id = ba.id AND bt.status = 'unmatched') AS unmatched,
           (SELECT bt.running_balance FROM bank_transactions bt
             WHERE bt.bank_account_id = ba.id AND bt.running_balance IS NOT NULL
             ORDER BY bt.txn_date DESC, bt.id DESC LIMIT 1) AS bank_balance,
           (SELECT DATE_FORMAT(bt.txn_date, '%Y-%m-%d') FROM bank_transactions bt
             WHERE bt.bank_account_id = ba.id AND bt.running_balance IS NOT NULL
             ORDER BY bt.txn_date DESC, bt.id DESC LIMIT 1) AS bank_balance_on
      FROM bank_accounts ba
     WHERE ba.org_id = ${orgId}
       ${status === 'all' ? sql`` : sql`AND ba.is_active = ${status === 'active' ? 1 : 0}`}
     ORDER BY ba.is_primary DESC, ba.name
  `.execute(ex);
  return rows.map((r) => ({
    id: r.id, kind: r.kind, name: r.name, code: r.account_code, currency: r.currency || 'INR',
    accountNumber: r.account_number, accountLast4: r.account_last4, bankName: r.bank_name, ifsc: r.ifsc,
    description: r.description, userIds: ids(r.user_ids), isPrimary: !!r.is_primary, isActive: !!r.is_active,
    ledgerAccountId: r.ledger_account_id, uncategorized: Number(r.unmatched),
    // The opening balance is posted as an entry when the account is added, so the movement is the balance.
    amountInBooksPaise: toPaiseFromSql(r.movement),
    amountInBankPaise: r.bank_balance == null ? null : toPaiseFromSql(r.bank_balance),
    amountInBankOn: r.bank_balance_on,
  })).filter((a) => canSeeAccount(a, opts.viewer ?? null));
}

export type OverviewPeriod = '30d' | '12m';

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);

/** The days (Last 30 days) or month ends (Last 12 months) the chart is drawn at. */
export function chartPoints(period: OverviewPeriod, today = istDate()): string[] {
  if (period === '30d') return Array.from({ length: 30 }, (_, i) => addDays(today, i - 29));
  const [y, m] = today.split('-').map(Number);
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (11 - i), 1));
    const end = monthEnd(d.getUTCFullYear(), d.getUTCMonth());
    return end > today ? today : end;
  });
}

/**
 * Each tile's balance at each point: the ledger balance of its accounts at the
 * end of that day. One read of the movements, carried forward in order.
 */
export async function balanceSeries(
  ex: Executor, orgId: number, accounts: Pick<BankAccountFigures, 'kind' | 'ledgerAccountId'>[], period: OverviewPeriod, today = istDate(),
): Promise<{ points: string[]; series: Record<TileKey, Paise[]> }> {
  const points = chartPoints(period, today);
  const series = { bank: [], card: [], cash: [], clearing: [] } as Record<TileKey, Paise[]>;
  const ledgers = accounts.map((a) => a.ledgerAccountId);
  if (!ledgers.length) {
    for (const k of Object.keys(series) as TileKey[]) series[k] = points.map(() => 0);
    return { points, series };
  }
  const first = period === '30d' ? points[0] : `${points[0].slice(0, 7)}-01`;
  const { rows: opening } = await sql<{ account_id: number; b: string }>`
    SELECT account_id, COALESCE(SUM(debit - credit), 0) AS b FROM journal_lines
     WHERE org_id = ${orgId} AND account_id IN (${sql.join(ledgers)}) AND entry_date < ${first}
     GROUP BY account_id`.execute(ex);
  const { rows: moves } = await sql<{ account_id: number; d: string; m: string }>`
    SELECT account_id, DATE_FORMAT(entry_date, '%Y-%m-%d') AS d, SUM(debit - credit) AS m FROM journal_lines
     WHERE org_id = ${orgId} AND account_id IN (${sql.join(ledgers)}) AND entry_date BETWEEN ${first} AND ${today}
     GROUP BY account_id, entry_date ORDER BY entry_date`.execute(ex);
  const tileOf = new Map<number, TileKey>();
  for (const a of accounts) {
    const t = (Object.keys(TILE_KINDS) as TileKey[]).find((k) => (TILE_KINDS[k] as readonly string[]).includes(a.kind));
    if (t) tileOf.set(a.ledgerAccountId, t);
  }
  const running: Record<TileKey, Paise> = { bank: 0, card: 0, cash: 0, clearing: 0 };
  for (const o of opening) { const t = tileOf.get(o.account_id); if (t) running[t] += toPaiseFromSql(o.b); }
  let i = 0;
  for (const p of points) {
    while (i < moves.length && moves[i].d <= p) {
      const t = tileOf.get(moves[i].account_id);
      if (t) running[t] += toPaiseFromSql(moves[i].m);
      i++;
    }
    for (const k of Object.keys(series) as TileKey[]) series[k].push(running[k]);
  }
  return { points, series };
}

/** Zoho's Banking Overview: the tiles, the uncategorised count, the chart and the accounts. */
export async function bankingOverview(
  ex: Executor, orgId: number, opts: { period?: OverviewPeriod; accountId?: number | null; status?: 'active' | 'inactive' | 'all'; viewer?: Viewer | null } = {},
) {
  const period = opts.period ?? '30d';
  const active = await accountsWithFigures(ex, orgId, { status: 'active', viewer: opts.viewer });
  const listed = opts.status && opts.status !== 'active' ? await accountsWithFigures(ex, orgId, { status: opts.status, viewer: opts.viewer }) : active;
  // "All Accounts ▾": the tiles and the chart for every account, or for one.
  const scope = opts.accountId ? active.filter((a) => a.id === opts.accountId) : active;
  if (opts.accountId && !scope.length) throw notFound('That account does not exist.');
  const tiles = (Object.keys(TILE_KINDS) as TileKey[]).map((k) => {
    const of = scope.filter((a) => (TILE_KINDS[k] as readonly string[]).includes(a.kind));
    return { key: k, amountPaise: of.reduce((t, a) => t + a.amountInBooksPaise, 0), accounts: of.length };
  });
  const chart = await balanceSeries(ex, orgId, scope, period);
  return {
    period,
    accountId: opts.accountId ?? null,
    tiles,
    uncategorized: scope.reduce((t, a) => t + a.uncategorized, 0),
    chart,
    accounts: listed,
  };
}

/** Zoho's names for what posted to a bank account, for the "All Transactions" view. */
const SOURCE_LABEL: Record<string, string> = {
  payment_received: 'Customer Payment', payment_made: 'Vendor Payment', expense: 'Expense', transfer: 'Transfer Fund',
  bank_txn: 'Categorized', manual: 'Manual Journal', opening: 'Opening Balance', opening_balance: 'Opening Balance', invoice: 'Invoice',
  bill: 'Bill', credit_note_refund: 'Credit Note Refund', vendor_credit_refund: 'Vendor Credit Refund', credit_note: 'Credit Note',
  retainer: 'Retainer Payment', payroll_payment: 'Salary Payment', statutory_payment: 'Tax Payment', asset_purchase: 'Asset Purchase',
};
export const sourceLabel = (t: string) => SOURCE_LABEL[t] ?? t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Zoho's "All Transactions — In Zoho Books": what the books hold for the
 * account, newest first, with the balance after each, and whether a statement
 * line has been matched to it (Matched), it was made from a statement line
 * (Categorized), or it was entered in the books and no line claims it yet
 * (Manually Added).
 */
export async function bookTransactions(
  ex: Executor, orgId: number, bankAccountId: number, opts: { from?: string | null; to?: string | null; direction?: 'in' | 'out' | null; limit?: number } = {},
) {
  const acct = await ex.selectFrom('bank_accounts').select(['id', 'name', 'ledger_account_id'])
    .where('id', '=', bankAccountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!acct) throw notFound('That account does not exist.');
  const to = opts.to ?? istDate();
  const { rows } = await sql<{
    entry_id: number; entry_no: number; entry_date: string; memo: string | null; source_type: string; source_id: number | null;
    debit: string; credit: string; party: string | null; line_id: number;
  }>`
    SELECT e.id AS entry_id, e.entry_no, DATE_FORMAT(jl.entry_date, '%Y-%m-%d') AS entry_date, e.memo, e.source_type, e.source_id,
           jl.debit, jl.credit, jl.id AS line_id,
           (SELECT c.display_name FROM journal_lines x JOIN contacts c ON c.id = x.contact_id
             WHERE x.entry_id = e.id AND x.contact_id IS NOT NULL LIMIT 1) AS party
      FROM journal_lines jl JOIN journal_entries e ON e.id = jl.entry_id
     WHERE jl.org_id = ${orgId} AND jl.account_id = ${acct.ledger_account_id} AND jl.entry_date <= ${to}
       ${opts.from ? sql`AND jl.entry_date >= ${opts.from}` : sql``}
     ORDER BY jl.entry_date, jl.id`.execute(ex);
  const opening = opts.from
    ? toPaiseFromSql((await sql<{ b: string }>`SELECT COALESCE(SUM(debit - credit), 0) AS b FROM journal_lines
        WHERE org_id = ${orgId} AND account_id = ${acct.ledger_account_id} AND entry_date < ${opts.from}`.execute(ex)).rows[0]?.b ?? '0')
    : 0;

  // What statement lines claim: a line's direct match, everything it is linked to, and entries made from a line.
  const { rows: claims } = await sql<{ t: string; id: number }>`
    SELECT matched_type AS t, matched_id AS id FROM bank_transactions
     WHERE org_id = ${orgId} AND bank_account_id = ${bankAccountId} AND status = 'matched' AND matched_id IS NOT NULL
    UNION SELECT l.target_type AS t, l.target_id AS id FROM bank_transaction_links l
      JOIN bank_transactions bt ON bt.id = l.bank_transaction_id
     WHERE l.org_id = ${orgId} AND bt.bank_account_id = ${bankAccountId}`.execute(ex);
  const claimed = new Set(claims.map((c) => `${c.t}:${c.id}`));
  const isClaimed = (r: { entry_id: number; source_type: string; source_id: number | null }) =>
    claimed.has(`journal_entry:${r.entry_id}`) || (r.source_id != null && (claimed.has(`${r.source_type}:${r.source_id}`)
      || (r.source_type.startsWith('payment') && claimed.has(`payment:${r.source_id}`))));

  let balance = opening;
  const all = rows.map((r) => {
    const deposit = toPaiseFromSql(r.debit);
    const withdrawal = toPaiseFromSql(r.credit);
    balance += deposit - withdrawal;
    const status = r.source_type === 'bank_txn' ? 'Categorized' : isClaimed(r) ? 'Matched' : 'Manually Added';
    return {
      entryId: String(r.entry_id), entryNo: r.entry_no, date: r.entry_date, reference: r.memo, party: r.party,
      // Typed in on the account (Add Transaction): its memo starts with what it was ("Expense Refund: …").
      type: r.source_type === 'bank_entry' ? (r.memo?.split(':')[0]?.trim() || 'Deposit') : sourceLabel(r.source_type), sourceType: r.source_type, sourceId: r.source_id == null ? null : String(r.source_id),
      status, depositPaise: deposit, withdrawalPaise: withdrawal, runningBalancePaise: balance,
    };
  });
  const kept = opts.direction ? all.filter((t) => (opts.direction === 'in' ? t.depositPaise > 0 : t.withdrawalPaise > 0)) : all;
  return {
    account: { id: String(acct.id), name: acct.name },
    openingPaise: opening,
    closingPaise: balance,
    transactions: kept.reverse().slice(0, opts.limit ?? 500),
  };
}
