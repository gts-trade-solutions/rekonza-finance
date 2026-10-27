import 'server-only';

// Reports as rows, for a workbook made on the server: what a scheduled report
// sends. The same aggregates the screens use, laid out as the screens' own
// exports lay them out.

import type { Executor } from '../db';
import type { Sheet } from '../../xlsx';
import { ageing, balanceSheet, profitAndLoss, trialBalance, AGEING_BUCKETS } from './statements';
import { cashForecast } from './cash-forecast';

export const SCHEDULABLE = {
  'trial-balance': 'Trial balance',
  'profit-and-loss': 'Profit and loss',
  'balance-sheet': 'Balance sheet',
  'ar-ageing': 'Receivables ageing',
  'ap-ageing': 'Payables ageing',
  'cash-forecast': 'Cash-flow forecast',
} as const;
export type SchedulableReport = keyof typeof SCHEDULABLE;

const r = (paise: number) => Math.round(paise) / 100;

export async function tabulate(
  ex: Executor, orgId: number, report: SchedulableReport, range: { from: string; to: string },
): Promise<Sheet[]> {
  const head = (title: string, when: string) => [[title], [when], []];
  switch (report) {
    case 'trial-balance': {
      const tb = await trialBalance(ex, orgId, range.to);
      return [{ name: 'Trial balance', rows: [
        ...head('Trial balance', `As at ${range.to}`),
        ['Code', 'Account', 'Type', 'Debit', 'Credit'],
        ...tb.rows.map((x) => [x.code, x.name, x.type, r(x.debitSide), r(x.creditSide)]),
        ['', 'Total', '', r(tb.totalDebit), r(tb.totalCredit)],
      ] }];
    }
    case 'profit-and-loss': {
      const pl = await profitAndLoss(ex, orgId, range.from, range.to);
      return [{ name: 'Profit and loss', rows: [
        ...head('Profit and loss', `${range.from} to ${range.to}`),
        ['Section', 'Code', 'Account', 'Amount'],
        ...pl.incomeRows.map((x) => ['Income', x.code, x.name, r(x.balancePaise)]),
        ['', '', 'Total income', r(pl.totalIncome)],
        ...pl.expenseRows.map((x) => ['Expenses', x.code, x.name, r(x.balancePaise)]),
        ['', '', 'Total expenses', r(pl.totalExpense)],
        ['Stock', '', 'Add: opening stock', r(pl.openingStockPaise)],
        ['Stock', '', 'Less: closing stock', r(-pl.closingStockPaise)],
        ['', '', 'Net profit', r(pl.netProfit)],
      ] }];
    }
    case 'balance-sheet': {
      const bs = await balanceSheet(ex, orgId, range.to);
      return [{ name: 'Balance sheet', rows: [
        ...head('Balance sheet', `As at ${range.to}`),
        ['Section', 'Code', 'Account', 'Amount'],
        ...bs.assetRows.map((x) => ['Assets', x.code, x.name, r(x.balancePaise)]),
        ['', '', 'Total assets', r(bs.totalAssets)],
        ...bs.liabilityRows.map((x) => ['Liabilities', x.code, x.name, r(x.balancePaise)]),
        ['', '', 'Total liabilities', r(bs.totalLiabilities)],
        ...bs.equityRows.map((x) => ['Equity', x.code, x.name, r(x.balancePaise)]),
        ['Equity', '', 'Retained earnings from earlier years', r(bs.priorYearsEarnings)],
        ['Equity', '', 'Current period earnings', r(bs.currentPeriodEarnings)],
        ['', '', 'Total equity', r(bs.totalEquity)],
      ] }];
    }
    case 'ar-ageing':
    case 'ap-ageing': {
      const side = report === 'ar-ageing' ? 'receivable' : 'payable';
      const a = await ageing(ex, orgId, side, range.to);
      return [{ name: side === 'receivable' ? 'Receivables' : 'Payables', rows: [
        ...head(SCHEDULABLE[report], `As at ${range.to}, by days past due`),
        ['Party', ...AGEING_BUCKETS, 'Total'],
        ...a.rows.map((x) => [x.name, ...AGEING_BUCKETS.map((b) => r(x.buckets[b] ?? 0)), r(x.totalPaise)]),
        ['Total', ...AGEING_BUCKETS.map((b) => r(a.totals[b] ?? 0)), r(a.grandTotalPaise)],
      ] }];
    }
    case 'cash-forecast': {
      const f = await cashForecast(ex, orgId, { today: range.to, weeks: 13 });
      return [{ name: 'Forecast', rows: [
        ...head('Cash-flow forecast', `From ${f.today}, thirteen weeks`),
        ['Week from', 'Week to', 'In', 'Out', 'Closing'],
        ['', f.today, '', '', r(f.openingPaise)],
        ...f.weeks.map((w) => [w.start, w.end, r(w.inPaise), r(w.outPaise), r(w.closingPaise)]),
      ] }];
    }
  }
}
