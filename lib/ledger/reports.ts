// ─────────────────────────────────────────────────────────────────────────────
// Report derivations — every financial report is a pure function over
// (accounts, journal entries). There is no stored "report data" anywhere.
// ─────────────────────────────────────────────────────────────────────────────

import type { Account, AccountType, JournalEntry, Paise } from '../types';

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  debit: Paise; // closing side
  credit: Paise;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebit: Paise;
  totalCredit: Paise;
  balanced: boolean;
}

/** Natural balance side: assets/expenses are debit-normal; the rest credit-normal. */
export function isDebitNormal(t: AccountType): boolean {
  return t === 'asset' || t === 'expense';
}

function inRange(date: string, from?: string, to?: string): boolean {
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

/** Net movement per account over a date range. +ve = net debit. */
export function accountNets(
  entries: JournalEntry[],
  opts: { from?: string; to?: string } = {},
): Map<string, Paise> {
  const nets = new Map<string, Paise>();
  for (const e of entries) {
    if (!inRange(e.date, opts.from, opts.to)) continue;
    for (const l of e.lines) {
      nets.set(l.accountId, (nets.get(l.accountId) ?? 0) + l.debit - l.credit);
    }
  }
  return nets;
}

export function trialBalance(
  accounts: Account[],
  entries: JournalEntry[],
  opts: { to?: string } = {},
): TrialBalance {
  const nets = accountNets(entries, { to: opts.to });
  const rows: TrialBalanceRow[] = [];
  let totalDebit = 0;
  let totalCredit = 0;
  for (const a of accounts) {
    const net = nets.get(a.id) ?? 0;
    if (net === 0) continue;
    const row: TrialBalanceRow = {
      accountId: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
      debit: net > 0 ? net : 0,
      credit: net < 0 ? -net : 0,
    };
    totalDebit += row.debit;
    totalCredit += row.credit;
    rows.push(row);
  }
  rows.sort((x, y) => x.code.localeCompare(y.code));
  return { rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
}

export interface PLReport {
  incomeRows: { account: Account; amount: Paise }[];
  expenseRows: { account: Account; amount: Paise }[];
  totalIncome: Paise;
  totalExpense: Paise;
  netProfit: Paise;
}

/** P&L over a date range. Income shown +ve when credit-net, expenses +ve when debit-net. */
export function profitAndLoss(
  accounts: Account[],
  entries: JournalEntry[],
  opts: { from: string; to: string },
): PLReport {
  const nets = accountNets(entries, opts);
  const incomeRows: PLReport['incomeRows'] = [];
  const expenseRows: PLReport['expenseRows'] = [];
  let totalIncome = 0;
  let totalExpense = 0;
  for (const a of accounts) {
    const net = nets.get(a.id) ?? 0;
    if (net === 0) continue;
    if (a.type === 'income') {
      const amt = -net; // credit-normal
      incomeRows.push({ account: a, amount: amt });
      totalIncome += amt;
    } else if (a.type === 'expense') {
      expenseRows.push({ account: a, amount: net });
      totalExpense += net;
    }
  }
  incomeRows.sort((x, y) => y.amount - x.amount);
  expenseRows.sort((x, y) => y.amount - x.amount);
  return { incomeRows, expenseRows, totalIncome, totalExpense, netProfit: totalIncome - totalExpense };
}

export interface BalanceSheetReport {
  assetRows: { account: Account; amount: Paise }[];
  liabilityRows: { account: Account; amount: Paise }[];
  equityRows: { account: Account; amount: Paise }[];
  currentEarnings: Paise; // P&L net folded into equity so the sheet balances
  totalAssets: Paise;
  totalLiabEquity: Paise;
  balanced: boolean;
}

export function balanceSheet(
  accounts: Account[],
  entries: JournalEntry[],
  opts: { to: string },
): BalanceSheetReport {
  const nets = accountNets(entries, { to: opts.to });
  const assetRows: BalanceSheetReport['assetRows'] = [];
  const liabilityRows: BalanceSheetReport['liabilityRows'] = [];
  const equityRows: BalanceSheetReport['equityRows'] = [];
  let totalAssets = 0;
  let totalLiab = 0;
  let totalEquity = 0;
  let currentEarnings = 0;

  for (const a of accounts) {
    const net = nets.get(a.id) ?? 0;
    if (net === 0) continue;
    switch (a.type) {
      case 'asset':
        assetRows.push({ account: a, amount: net });
        totalAssets += net;
        break;
      case 'liability':
        liabilityRows.push({ account: a, amount: -net });
        totalLiab += -net;
        break;
      case 'equity':
        equityRows.push({ account: a, amount: -net });
        totalEquity += -net;
        break;
      case 'income':
        currentEarnings += -net;
        break;
      case 'expense':
        currentEarnings -= net;
        break;
    }
  }
  assetRows.sort((x, y) => y.amount - x.amount);
  liabilityRows.sort((x, y) => y.amount - x.amount);
  const totalLiabEquity = totalLiab + totalEquity + currentEarnings;
  return {
    assetRows,
    liabilityRows,
    equityRows,
    currentEarnings,
    totalAssets,
    totalLiabEquity,
    balanced: totalAssets === totalLiabEquity,
  };
}

export interface GLRow {
  entryId: string;
  entryNo: number;
  date: string;
  memo: string;
  sourceType: string;
  sourceId: string | null;
  debit: Paise;
  credit: Paise;
  running: Paise;
}

/** General ledger for one account, with running balance. */
export function generalLedger(
  entries: JournalEntry[],
  accountId: string,
  opts: { from?: string; to?: string } = {},
): GLRow[] {
  const rows: GLRow[] = [];
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.entryNo - b.entryNo);
  let running = 0;
  for (const e of sorted) {
    for (const l of e.lines) {
      if (l.accountId !== accountId) continue;
      running += l.debit - l.credit;
      if (!inRange(e.date, opts.from, opts.to)) continue;
      rows.push({
        entryId: e.id,
        entryNo: e.entryNo,
        date: e.date,
        memo: e.memo,
        sourceType: e.sourceType,
        sourceId: e.sourceId,
        debit: l.debit,
        credit: l.credit,
        running,
      });
    }
  }
  return rows;
}

export const AGEING_BUCKETS = ['Current', '1–15', '16–30', '31–45', '46–60', '60+'] as const;

export function ageingBucket(dueDate: string, asOf: string): (typeof AGEING_BUCKETS)[number] {
  const days = Math.floor(
    (new Date(asOf).getTime() - new Date(dueDate).getTime()) / 86_400_000,
  );
  if (days <= 0) return 'Current';
  if (days <= 15) return '1–15';
  if (days <= 30) return '16–30';
  if (days <= 45) return '31–45';
  if (days <= 60) return '46–60';
  return '60+';
}
