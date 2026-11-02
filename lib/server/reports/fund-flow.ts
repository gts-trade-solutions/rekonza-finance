import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Fund flow statement: where the business's long-term funds came from over a
// period, and what they were applied to — with the change in working capital
// as the balancing item, scheduled current item by current item.
//
// Built from the two balance sheets (the day before the period and its last
// day) and the depreciation charged in between, so it ties out by
// construction: sources always equal applications, and both are read from the
// same ledger as every other statement.
//
//   Sources        funds from operations (profit + depreciation + loss on
//                  sale of assets), new capital, new long-term borrowing,
//                  assets sold
//   Applications   assets bought, borrowing repaid, drawings, the increase
//                  in working capital
//
// Fixed assets are taken net of depreciation, with the period's depreciation
// added back to operations; the net change is shown as bought (or sold, when
// the block shrank by more than its depreciation).
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { CODE } from '../ledger/chart-of-accounts';
import { balanceSheet, type AccountBalance } from './statements';
import { dayBefore } from './stock';

const NON_CURRENT_ASSET = new Set(['fixed_asset', 'cwip', 'investment', 'deposit', 'misc_expense']);
const LONG_TERM_LIABILITY = new Set(['loan']);

export interface FundFlowLine { label: string; amountPaise: Paise }
export interface WorkingCapitalLine { label: string; openingPaise: Paise; closingPaise: Paise; increasePaise: Paise; decreasePaise: Paise }

export interface FundFlow {
  from: string;
  to: string;
  sources: FundFlowLine[];
  applications: FundFlowLine[];
  totalSourcesPaise: Paise;
  totalApplicationsPaise: Paise;
  /** Funds from operations, and how it was arrived at. */
  operations: { profitPaise: Paise; depreciationPaise: Paise; lossOnSalePaise: Paise; totalPaise: Paise };
  workingCapital: {
    lines: WorkingCapitalLine[];
    openingPaise: Paise;
    closingPaise: Paise;
    /** Positive: working capital grew (an application); negative: it shrank (a source). */
    changePaise: Paise;
  };
  balanced: boolean;
}

const key = (r: AccountBalance) => `${r.type}:${r.accountId}`;

export async function fundFlow(ex: Executor, orgId: number, from: string, to: string): Promise<FundFlow> {
  const [open, close] = await Promise.all([balanceSheet(ex, orgId, dayBefore(from)), balanceSheet(ex, orgId, to)]);
  const { rows: charged } = await sql<{ code: string; v: string }>`
    SELECT a.code, COALESCE(SUM(jl.debit - jl.credit), 0) AS v
      FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
     WHERE jl.org_id = ${orgId} AND a.code IN (${CODE.DEPRECIATION}, ${CODE.LOSS_ON_ASSET_SALE})
       AND jl.entry_date BETWEEN ${from} AND ${to}
     GROUP BY a.code
  `.execute(ex);
  const depreciationPaise = toPaiseFromSql(charged.find((r) => r.code === CODE.DEPRECIATION)?.v ?? '0');
  const lossOnSalePaise = toPaiseFromSql(charged.find((r) => r.code === CODE.LOSS_ON_ASSET_SALE)?.v ?? '0');

  // The period's profit as the balance sheet sees it: the change in what the
  // owners have earned, stock movement included.
  const earned = (b: typeof open) => b.priorYearsEarnings + b.currentPeriodEarnings;
  const profitPaise = earned(close) - earned(open);

  // Every balance-sheet row at either date, by account.
  const rows = new Map<string, { label: string; code: string; type: string; subtype: string | null; open: Paise; close: Paise }>();
  const add = (list: AccountBalance[], side: 'open' | 'close') => {
    for (const r of list) {
      const k = key(r);
      const row = rows.get(k) ?? { label: r.name, code: r.code, type: r.type, subtype: r.subtype, open: 0, close: 0 };
      row[side] = r.balancePaise;
      rows.set(k, row);
    }
  };
  add([...open.assetRows, ...open.liabilityRows, ...open.equityRows], 'open');
  add([...close.assetRows, ...close.liabilityRows, ...close.equityRows], 'close');

  const all = [...rows.values()];
  const current = all.filter((r) => (r.type === 'asset' && !NON_CURRENT_ASSET.has(r.subtype ?? '')) || (r.type === 'liability' && !LONG_TERM_LIABILITY.has(r.subtype ?? '')));
  const nonCurrentAssets = all.filter((r) => r.type === 'asset' && NON_CURRENT_ASSET.has(r.subtype ?? ''));
  const longTerm = all.filter((r) => r.type === 'liability' && LONG_TERM_LIABILITY.has(r.subtype ?? ''));
  const equity = all.filter((r) => r.type === 'equity');

  // Working capital, item by item: a current asset rising, or a current
  // liability falling, increases it.
  const wcLines: WorkingCapitalLine[] = current
    .filter((r) => r.open !== 0 || r.close !== 0)
    .map((r) => {
      const sign = r.type === 'asset' ? 1 : -1;
      const effect = sign * (r.close - r.open);
      return { label: r.type === 'liability' ? `${r.label} (liability)` : r.label, openingPaise: sign * r.open, closingPaise: sign * r.close, increasePaise: Math.max(effect, 0), decreasePaise: Math.max(-effect, 0) };
    });
  const wcOpen = wcLines.reduce((t, l) => t + l.openingPaise, 0);
  const wcClose = wcLines.reduce((t, l) => t + l.closingPaise, 0);
  const wcChange = wcClose - wcOpen;

  const operationsTotal = profitPaise + depreciationPaise + lossOnSalePaise;
  const sources: FundFlowLine[] = [];
  const applications: FundFlowLine[] = [];
  const put = (label: string, amount: Paise) => {
    if (amount > 0) sources.push({ label, amountPaise: amount });
    else if (amount < 0) applications.push({ label, amountPaise: -amount });
  };

  put(operationsTotal >= 0 ? 'Funds from operations' : 'Funds lost in operations', operationsTotal);
  // Owners' money: capital brought in is a source; drawings (a debit-balance equity account) an application.
  for (const r of equity) {
    const change = r.close - r.open;
    if (!change) continue;
    // Opening Balance Equity moves when opening balances are typed in: it is
    // the books catching up, not money the owners put in.
    if (r.code === CODE.OPENING_BALANCE_EQUITY) put(change > 0 ? 'Opening balances entered in the period' : 'Opening balances corrected', change);
    else put(change > 0 ? `${r.label}: brought in` : `${r.label}: taken out`, change);
  }
  for (const r of longTerm) {
    const change = r.close - r.open;
    if (change) put(change > 0 ? `${r.label}: borrowed` : `${r.label}: repaid`, change);
  }
  // Non-current assets, net of depreciation: their growth plus the depreciation
  // and loss already added back is what was invested; a fall, what was realised.
  const ncaChange = nonCurrentAssets.reduce((t, r) => t + (r.close - r.open), 0);
  const invested = ncaChange + depreciationPaise + lossOnSalePaise;
  if (invested > 0) applications.push({ label: 'Fixed assets and investments bought (net of any sold)', amountPaise: invested });
  else if (invested < 0) sources.push({ label: 'Fixed assets and investments sold', amountPaise: -invested });
  if (wcChange > 0) applications.push({ label: 'Increase in working capital', amountPaise: wcChange });
  else if (wcChange < 0) sources.push({ label: 'Decrease in working capital', amountPaise: -wcChange });

  const totalSourcesPaise = sources.reduce((t, l) => t + l.amountPaise, 0);
  const totalApplicationsPaise = applications.reduce((t, l) => t + l.amountPaise, 0);
  return {
    from, to, sources, applications, totalSourcesPaise, totalApplicationsPaise,
    operations: { profitPaise, depreciationPaise, lossOnSalePaise, totalPaise: operationsTotal },
    workingCapital: { lines: wcLines, openingPaise: wcOpen, closingPaise: wcClose, changePaise: wcChange },
    balanced: totalSourcesPaise === totalApplicationsPaise,
  };
}
