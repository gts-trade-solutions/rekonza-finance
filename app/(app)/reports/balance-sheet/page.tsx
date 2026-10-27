'use client';

// What the business owns and owes on a single date.
//
// The piece people miss is earnings. No entry moves a year's profit into
// retained earnings, so the sheet works it out: profit of earlier financial
// years as retained earnings, this year's as current period earnings. Leave
// either out and the sheet fails to balance by exactly that profit.
//
// Closing stock is valued from the documents rather than read from a ledger,
// and opening stock — an opening balance — sits in equity beside it.
//
// Each account opens its ledger for the year to date, and the sheet can stand
// beside the one at the end of the period before or a year earlier.

import { useState } from 'react';
import Link from 'next/link';
import { Scale } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Money } from '@/components/shared/money';
import { CompareSelect, downloadCsv, ReportShell, ReportTable, useReportRange } from '@/components/shared/report-shell';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { reports, type AccountBalanceRow, type BalanceSheetReport } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';
import { comparisonRange, type CompareMode } from '@/lib/date-range';
import { ledgerHref } from '@/lib/source-links';

const asAt = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

function Group({
  title,
  rows,
  total,
  extras = [],
  prev,
  ledger,
}: {
  title: string;
  rows: AccountBalanceRow[];
  total: number;
  extras?: { label: string; value: number; hint: string; before?: number }[];
  /** The same group on the comparison date. */
  prev?: { rows: AccountBalanceRow[]; total: number; label: string } | null;
  ledger: { from: string; to: string };
}) {
  const then = new Map((prev?.rows ?? []).map((r) => [r.accountId, r.balancePaise]));
  const all = prev ? [...rows, ...prev.rows.filter((p) => !rows.some((r) => r.accountId === p.accountId)).map((p) => ({ ...p, balancePaise: 0 }))] : rows;
  const cols = prev ? 3 : 2;
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center border-b bg-muted/40 px-4 py-2.5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
        {prev && <p className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">{prev.label}</p>}
      </div>
      <table className="w-full text-sm">
        <tbody>
          {all.length === 0 && extras.length === 0 && (
            <tr>
              <td className="px-4 py-3 text-sm text-muted-foreground" colSpan={cols}>Nothing here.</td>
            </tr>
          )}
          {all.map((r) => (
            <tr key={r.accountId} className="border-b last:border-0 hover:bg-accent/40">
              <td className="px-4 py-2">
                {r.code ? (
                  <Link href={ledgerHref(r.accountId, ledger.from, ledger.to)} className="hover:underline">
                    <span className="font-mono text-xs text-muted-foreground">{r.code}</span> {r.name}
                  </Link>
                ) : r.name}
                {!r.code && (
                  <span className="mt-0.5 block text-xs text-muted-foreground">Worked out from the documents</span>
                )}
              </td>
              <td className="px-4 py-2 text-right"><Money value={r.balancePaise} /></td>
              {prev && <td className="px-4 py-2 text-right text-muted-foreground"><Money value={then.get(r.accountId) ?? 0} /></td>}
            </tr>
          ))}
          {extras.map((extra) => (
            <tr key={extra.label} className="border-b last:border-0">
              <td className="px-4 py-2">
                {extra.label}
                <span className="mt-0.5 block text-xs text-muted-foreground">{extra.hint}</span>
              </td>
              <td className="px-4 py-2 text-right"><Money value={extra.value} /></td>
              {prev && <td className="px-4 py-2 text-right text-muted-foreground"><Money value={extra.before ?? 0} /></td>}
            </tr>
          ))}
          <tr className="border-t-2 bg-muted/30 font-semibold">
            <td className="px-4 py-2.5">Total {title.toLowerCase()}</td>
            <td className="px-4 py-2.5 text-right"><Money value={total} /></td>
            {prev && <td className="px-4 py-2.5 text-right text-muted-foreground"><Money value={prev.total} /></td>}
          </tr>
        </tbody>
      </table>
    </Card>
  );
}

export default function BalanceSheetPage() {
  const [range, setRange] = useReportRange();
  const [compare, setCompare] = useState<CompareMode>('none');
  const state = useApi<BalanceSheetReport>(() => reports.balanceSheet(range.to), [range.to]);
  const cmpTo = compare === 'none' ? null : comparisonRange(range, compare).to;
  const prevState = useApi<BalanceSheetReport | null>(() => (cmpTo ? reports.balanceSheet(cmpTo) : Promise.resolve(null)), [cmpTo]);
  const prev = cmpTo ? prevState.data ?? null : null;
  const label = cmpTo ? `At ${asAt(cmpTo)}` : '';

  return (
    <ReportShell
      title="Balance Sheet"
      description="What the business owns and owes on a single date. Assets must equal liabilities plus equity."
      range={range}
      onRangeChange={setRange}
      asOfOnly
      extraActions={<div className="w-52"><CompareSelect value={compare} onChange={setCompare} /></div>}
      onExport={() => {
        const bs = state.data;
        if (!bs) return;
        downloadCsv('balance-sheet.csv', [
          ['Section', 'Code', 'Account', 'Amount'],
          ...bs.assetRows.map((r) => ['Assets', r.code, r.name, toRupees(r.balancePaise)]),
          ['', '', 'Total assets', toRupees(bs.totalAssets)],
          ...bs.liabilityRows.map((r) => ['Liabilities', r.code, r.name, toRupees(r.balancePaise)]),
          ['', '', 'Total liabilities', toRupees(bs.totalLiabilities)],
          ...bs.equityRows.map((r) => ['Equity', r.code, r.name, toRupees(r.balancePaise)]),
          ['Equity', '', 'Retained earnings from earlier years', toRupees(bs.priorYearsEarnings)],
          ['Equity', '', 'Current period earnings', toRupees(bs.currentPeriodEarnings)],
          ['', '', 'Total equity', toRupees(bs.totalEquity)],
        ]);
      }}
    >
      <AsyncPage state={state} loading={<LoadingRows rows={10} />}>
        {(bs) => (
          <>
            <Card
              className={
                'flex items-center gap-3 p-4 ' +
                (bs.balanced ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-destructive bg-destructive/5')
              }
            >
              <Scale
                className={
                  'size-5 shrink-0 ' +
                  (bs.balanced ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')
                }
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {bs.balanced
                    ? 'Assets equal liabilities plus equity'
                    : 'The sheet does NOT balance — investigate immediately'}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  <Money value={bs.totalAssets} /> in assets against{' '}
                  <Money value={bs.totalLiabilities} /> owed and <Money value={bs.totalEquity} /> of equity.
                </p>
              </div>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              <Group title="Assets" rows={bs.assetRows} total={bs.totalAssets} ledger={{ from: bs.fyStart, to: bs.asOf }}
                prev={prev && { rows: prev.assetRows, total: prev.totalAssets, label }} />
              <div className="space-y-4">
                <Group title="Liabilities" rows={bs.liabilityRows} total={bs.totalLiabilities} ledger={{ from: bs.fyStart, to: bs.asOf }}
                  prev={prev && { rows: prev.liabilityRows, total: prev.totalLiabilities, label }} />
                <Group
                  title="Equity"
                  rows={bs.equityRows}
                  total={bs.totalEquity}
                  ledger={{ from: bs.fyStart, to: bs.asOf }}
                  prev={prev && { rows: prev.equityRows, total: prev.totalEquity, label }}
                  extras={[
                    ...(bs.priorYearsEarnings !== 0 || prev?.priorYearsEarnings
                      ? [{
                          label: 'Retained earnings from earlier years',
                          value: bs.priorYearsEarnings,
                          hint: 'Profit of every financial year before this one',
                          before: prev?.priorYearsEarnings,
                        }]
                      : []),
                    {
                      label: 'Current period earnings',
                      value: bs.currentPeriodEarnings,
                      before: prev?.currentPeriodEarnings,
                      hint: `Profit this financial year, since ${new Date(`${bs.fyStart}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`,
                    },
                  ]}
                />
              </div>
            </div>

            <ReportTable>
              <tbody>
                <tr className="text-base font-semibold">
                  <td className="px-4 py-3">Assets</td>
                  <td className="px-4 py-3 text-right"><Money value={bs.totalAssets} /></td>
                  <td className="px-4 py-3 text-center text-muted-foreground">=</td>
                  <td className="px-4 py-3">Liabilities + equity</td>
                  <td className="px-4 py-3 text-right">
                    <Money value={bs.totalLiabilities + bs.totalEquity} />
                  </td>
                </tr>
              </tbody>
            </ReportTable>
          </>
        )}
      </AsyncPage>
    </ReportShell>
  );
}
