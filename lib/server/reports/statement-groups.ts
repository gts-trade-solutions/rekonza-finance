import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The profit and loss and the balance sheet, grouped by category the way Zoho
// Books' standard reports group them — and the same groups laid side by side
// for the horizontal (T-form) layout that Tally and every Indian accountant
// learnt on.
//
// Profit and loss: Operating Income, Cost of Goods Sold, Gross Profit,
// Operating Expense, Operating Profit, Non Operating Income and Expense, Net
// Profit. Balance sheet: Current Assets (Cash, Bank, Accounts Receivable,
// Other Current Assets), Fixed Assets, Other Assets; Current Liabilities
// (Accounts Payable, Other Current Liabilities), Long Term Liabilities, Other
// Liabilities; Equities.
//
// The figures are exactly the ordinary statements' (statements.ts) — only the
// grouping differs, and the totals are checked against them. An account's
// place follows its Schedule III line, so a CA who has moved an account there
// (accounts.schedule_iii_line) moves it here too.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor } from '../db';
import type { Paise } from '../../types';
import { CODE } from '../ledger/chart-of-accounts';
import { balanceSheet, profitAndLoss, type AccountBalance, type ReportBasis } from './statements';
import { lineOf, overrides } from './schedule-iii';

export interface GroupLine {
  /** An account id, or a figure worked out rather than posted (stock, earnings). */
  accountId: string;
  code: string;
  name: string;
  amountPaise: Paise;
  computed?: boolean;
}

export interface StatementGroup {
  key: string;
  label: string;
  lines: GroupLine[];
  /** Sub-groups, for the balance sheet's Current Assets and the like. */
  groups?: StatementGroup[];
  totalPaise: Paise;
}

const line = (r: AccountBalance, amountPaise = r.balancePaise): GroupLine => ({
  accountId: r.accountId, code: r.code, name: r.name, amountPaise, computed: !r.code,
});
const group = (key: string, label: string, lines: GroupLine[], groups?: StatementGroup[]): StatementGroup => ({
  key, label, lines, groups,
  totalPaise: lines.reduce((t, l) => t + l.amountPaise, 0) + (groups ?? []).reduce((t, g) => t + g.totalPaise, 0),
});

// ── Profit and loss ──────────────────────────────────────────────────────────

export interface GroupedProfitAndLoss {
  from: string;
  to: string;
  operatingIncome: StatementGroup;
  /** Opening stock, the direct costs, less closing stock. */
  costOfGoodsSold: StatementGroup;
  grossProfitPaise: Paise;
  operatingExpense: StatementGroup;
  operatingProfitPaise: Paise;
  nonOperatingIncome: StatementGroup;
  nonOperatingExpense: StatementGroup;
  netProfitPaise: Paise;
  /** For the T-form's trading account. */
  openingStockPaise: Paise;
  closingStockPaise: Paise;
}

const COGS_LINES = new Set(['purchases_stock_in_trade', 'cost_of_materials', 'changes_in_inventories']);
const NON_OPERATING_EXPENSE_CODES = new Set<string>([CODE.FX_LOSS, CODE.LOSS_ON_ASSET_SALE]);

export async function groupedProfitAndLoss(
  ex: Executor, orgId: number, from: string, to: string, branchId?: number, basis: ReportBasis = 'accrual',
): Promise<GroupedProfitAndLoss> {
  const [pl, over] = await Promise.all([profitAndLoss(ex, orgId, from, to, branchId, basis), overrides(ex, orgId)]);

  const opIncome: GroupLine[] = [];
  const nonOpIncome: GroupLine[] = [];
  for (const r of pl.incomeRows) (lineOf(r, over) === 'other_income' ? nonOpIncome : opIncome).push(line(r));

  const direct: GroupLine[] = [];
  const opExpense: GroupLine[] = [];
  const nonOpExpense: GroupLine[] = [];
  for (const r of pl.expenseRows) {
    const l = lineOf(r, over) ?? '';
    if (COGS_LINES.has(l)) direct.push(line(r));
    else if (l === 'finance_costs' || NON_OPERATING_EXPENSE_CODES.has(r.code)) nonOpExpense.push(line(r));
    else opExpense.push(line(r));
  }

  const cogsLines: GroupLine[] = [
    ...(pl.openingStockPaise ? [{ accountId: 'opening-stock', code: '', name: 'Opening Stock', amountPaise: pl.openingStockPaise, computed: true }] : []),
    ...direct,
    ...(pl.closingStockPaise ? [{ accountId: 'closing-stock', code: '', name: 'Closing Stock', amountPaise: -pl.closingStockPaise, computed: true }] : []),
  ];

  const operatingIncome = group('operating-income', 'Operating Income', opIncome);
  const costOfGoodsSold = group('cogs', 'Cost of Goods Sold', cogsLines);
  const operatingExpense = group('operating-expense', 'Operating Expense', opExpense);
  const nonOperatingIncome = group('non-operating-income', 'Non Operating Income', nonOpIncome);
  const nonOperatingExpense = group('non-operating-expense', 'Non Operating Expense', nonOpExpense);

  const grossProfitPaise = operatingIncome.totalPaise - costOfGoodsSold.totalPaise;
  const operatingProfitPaise = grossProfitPaise - operatingExpense.totalPaise;
  const netProfitPaise = operatingProfitPaise + nonOperatingIncome.totalPaise - nonOperatingExpense.totalPaise;
  if (netProfitPaise !== pl.netProfit) {
    // Every account is in exactly one group, so this cannot happen; if it ever
    // does, the ordinary statement is the one to believe.
    throw new Error(`Grouped profit ${netProfitPaise} differs from the statement's ${pl.netProfit}.`);
  }

  return {
    from, to,
    operatingIncome, costOfGoodsSold, grossProfitPaise,
    operatingExpense, operatingProfitPaise,
    nonOperatingIncome, nonOperatingExpense, netProfitPaise,
    openingStockPaise: pl.openingStockPaise,
    closingStockPaise: pl.closingStockPaise,
  };
}

// ── Balance sheet ────────────────────────────────────────────────────────────

export interface GroupedBalanceSheet {
  asOf: string;
  fyStart: string;
  assets: StatementGroup;
  liabilities: StatementGroup;
  equities: StatementGroup;
  totalLiabilitiesAndEquitiesPaise: Paise;
  balanced: boolean;
}

export async function groupedBalanceSheet(
  ex: Executor, orgId: number, asOf: string, branchId?: number, basis: ReportBasis = 'accrual',
): Promise<GroupedBalanceSheet> {
  const bs = await balanceSheet(ex, orgId, asOf, branchId, basis);

  const cash: GroupLine[] = [];
  const bank: GroupLine[] = [];
  const receivable: GroupLine[] = [];
  const otherCurrent: GroupLine[] = [];
  const fixed: GroupLine[] = [];
  const otherAssets: GroupLine[] = [];
  for (const r of bs.assetRows) {
    const s = r.subtype ?? '';
    if (s === 'cash') cash.push(line(r));
    else if (s === 'bank') bank.push(line(r));
    else if (r.code === CODE.AR || r.code === CODE.DOUBTFUL_DEBTS_PROVISION) receivable.push(line(r));
    else if (s === 'fixed_asset' || s === 'cwip' || s === 'intangible') fixed.push(line(r));
    else if (s === 'investment' || s === 'deposit' || s === 'misc_expense' || s === 'branch') otherAssets.push(line(r));
    else otherCurrent.push(line(r));
  }

  const payable: GroupLine[] = [];
  const otherCurrentLiab: GroupLine[] = [];
  const longTerm: GroupLine[] = [];
  const otherLiab: GroupLine[] = [];
  for (const r of bs.liabilityRows) {
    const s = r.subtype ?? '';
    if (r.code === CODE.AP) payable.push(line(r));
    else if (s === 'loan') longTerm.push(line(r));
    else if (s === 'deposit') otherLiab.push(line(r));
    else otherCurrentLiab.push(line(r));
  }

  // Earnings are worked out, not posted: what earlier years left in the
  // business sits with Retained Earnings, this year's is shown on its own.
  const equityLines: GroupLine[] = bs.equityRows.map((r) => line(r));
  const retained = equityLines.find((l) => l.code === CODE.RETAINED);
  if (retained) retained.amountPaise += bs.priorYearsEarnings;
  else if (bs.priorYearsEarnings) equityLines.push({ accountId: 'retained-earnings', code: '', name: 'Retained Earnings', amountPaise: bs.priorYearsEarnings, computed: true });
  equityLines.push({ accountId: 'current-year-earnings', code: '', name: 'Current Year Earnings', amountPaise: bs.currentPeriodEarnings, computed: true });

  const assets = group('assets', 'Assets', [], [
    group('current-assets', 'Current Assets', [], [
      group('cash', 'Cash', cash),
      group('bank', 'Bank', bank),
      group('accounts-receivable', 'Accounts Receivable', receivable),
      group('other-current-assets', 'Other current assets', otherCurrent),
    ]),
    group('fixed-assets', 'Fixed Assets', fixed),
    group('other-assets', 'Other Assets', otherAssets),
  ]);
  const liabilities = group('liabilities', 'Liabilities', [], [
    group('current-liabilities', 'Current Liabilities', [], [
      group('accounts-payable', 'Accounts Payable', payable),
      group('other-current-liabilities', 'Other Current Liabilities', otherCurrentLiab),
    ]),
    group('long-term-liabilities', 'Long Term Liabilities', longTerm),
    group('other-liabilities', 'Other Liabilities', otherLiab),
  ]);
  const equities = group('equities', 'Equities', equityLines);

  if (assets.totalPaise !== bs.totalAssets || liabilities.totalPaise !== bs.totalLiabilities || equities.totalPaise !== bs.totalEquity) {
    throw new Error('The grouped balance sheet does not agree with the statement.');
  }

  return {
    asOf, fyStart: bs.fyStart,
    assets, liabilities, equities,
    totalLiabilitiesAndEquitiesPaise: liabilities.totalPaise + equities.totalPaise,
    balanced: bs.balanced,
  };
}
