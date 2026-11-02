'use client';

// The profit and loss and the balance sheet in the formats Zoho Books offers:
// General (grouped by category), Horizontal (the T-form, two sides that agree)
// and Schedule III (the Companies Act layout, on its own page).
//
// General and Horizontal read the same grouped figures
// (lib/server/reports/statement-groups.ts); only the drawing differs.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Money } from '@/components/shared/money';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { ledgerHref } from '@/lib/source-links';
import { toRupees } from '@/lib/money';
import type { GroupedBalanceSheetReport, GroupedProfitAndLossReport, StatementGroup } from '@/lib/api/client';

export type StatementFormat = 'general' | 'horizontal';

export const FORMAT_LABEL: Record<StatementFormat | 'schedule-iii', string> = {
  general: 'General',
  horizontal: 'Horizontal (T-form)',
  'schedule-iii': 'Schedule III',
};

export function readFormat(v: string | null): StatementFormat {
  return v === 'horizontal' ? 'horizontal' : 'general';
}

/** The three formats; Schedule III opens its own page, on the matching statement. */
export function FormatSwitch({ value, statement, base }: { value: StatementFormat | 'schedule-iii'; statement: 'pl' | 'bs'; base: string }) {
  const router = useRouter();
  const items: (StatementFormat | 'schedule-iii')[] = ['general', 'horizontal', 'schedule-iii'];
  return (
    <div role="tablist" aria-label="Report format" className="inline-flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1 print:hidden">
      {items.map((f) => (
        <button
          key={f}
          type="button"
          role="tab"
          aria-selected={value === f}
          onClick={() => {
            if (f === value) return;
            if (f === 'schedule-iii') router.push(`/reports/schedule-iii?tab=${statement}`);
            else {
              const href = f === 'general' ? base : `${base}?format=${f}`;
              // Between General and Horizontal the page stays; from Schedule III it changes.
              if (value === 'schedule-iii') router.push(href);
              else router.replace(href);
            }
          }}
          className={cn(
            'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
            value === f ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {FORMAT_LABEL[f]}
        </button>
      ))}
    </div>
  );
}

// ── General ──────────────────────────────────────────────────────────────────

const pad = (depth: number) => ({ paddingLeft: `${1 + depth * 1.25}rem` });

function AccountName({ l, ledger }: { l: StatementGroup['lines'][number]; ledger: { from: string; to: string } }) {
  if (l.computed || !l.code) {
    return <span>{l.name}<span className="ml-2 text-[11px] text-muted-foreground">worked out</span></span>;
  }
  return (
    <Link href={ledgerHref(l.accountId, ledger.from, ledger.to)} className="hover:underline">
      {l.name} <span className="font-mono text-[11px] text-muted-foreground">{l.code}</span>
    </Link>
  );
}

/** Find the same group in the comparison report, by key. */
function findGroup(g: StatementGroup | undefined, key: string): StatementGroup | undefined {
  if (!g) return undefined;
  if (g.key === key) return g;
  for (const c of g.groups ?? []) {
    const f = findGroup(c, key);
    if (f) return f;
  }
  return undefined;
}

function GroupRows({ g, prev, depth, ledger, cols }: {
  g: StatementGroup; prev?: StatementGroup; depth: number; ledger: { from: string; to: string }; cols: number;
}) {
  const before = new Map((prev?.lines ?? []).map((l) => [l.accountId, l.amountPaise]));
  const lines = prev
    ? [...g.lines, ...prev.lines.filter((p) => !g.lines.some((l) => l.accountId === p.accountId)).map((p) => ({ ...p, amountPaise: 0 }))]
    : g.lines;
  const empty = lines.length === 0 && !(g.groups ?? []).some((c) => c.totalPaise !== 0 || c.lines.length);
  return (
    <>
      <tr className={depth === 0 ? 'bg-muted/40' : ''}>
        <td colSpan={cols} className={cn('py-2 pr-4 text-sm', depth === 0 ? 'font-semibold' : 'font-medium')} style={pad(depth)}>{g.label}</td>
      </tr>
      {lines.map((l) => (
        <tr key={l.accountId} className="border-b border-dashed last:border-0 hover:bg-accent/40">
          <td className="py-1.5 pr-4" style={pad(depth + 1)}><AccountName l={l} ledger={ledger} /></td>
          <td className="px-4 py-1.5 text-right"><Money value={l.amountPaise} /></td>
          {prev !== undefined && cols > 2 && <td className="px-4 py-1.5 text-right text-muted-foreground"><Money value={before.get(l.accountId) ?? 0} /></td>}
        </tr>
      ))}
      {(g.groups ?? []).map((c) => (
        <GroupRows key={c.key} g={c} prev={findGroup(prev, c.key) ?? (prev ? { ...c, lines: [], groups: [], totalPaise: 0 } : undefined)} depth={depth + 1} ledger={ledger} cols={cols} />
      ))}
      {empty && (
        <tr><td colSpan={cols} className="py-1.5 pr-4 text-xs text-muted-foreground" style={pad(depth + 1)}>No accounts</td></tr>
      )}
      <tr className="border-b font-medium">
        <td className="py-2 pr-4" style={pad(depth)}>Total for {g.label}</td>
        <td className="px-4 py-2 text-right"><Money value={g.totalPaise} /></td>
        {cols > 2 && <td className="px-4 py-2 text-right text-muted-foreground"><Money value={prev?.totalPaise ?? 0} /></td>}
      </tr>
    </>
  );
}

function ResultRow({ label, value, before, cols, strong }: { label: string; value: number; before?: number; cols: number; strong?: boolean }) {
  return (
    <tr className={cn('border-y-2', strong ? 'bg-muted/50 text-base font-semibold' : 'bg-muted/20 font-semibold')}>
      <td className="px-4 py-2.5">{label}</td>
      <td className={cn('px-4 py-2.5 text-right', strong && (value >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'))}><Money value={value} /></td>
      {cols > 2 && <td className="px-4 py-2.5 text-right text-muted-foreground"><Money value={before ?? 0} /></td>}
    </tr>
  );
}

function StatementTable({ children, prevLabel }: { children: React.ReactNode; prevLabel?: string }) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="overflow-x-auto thin-scroll">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="border-b bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2.5 text-left font-semibold">Account</th>
              <th className="px-4 py-2.5 text-right font-semibold">Total</th>
              {prevLabel && <th className="px-4 py-2.5 text-right font-semibold">{prevLabel}</th>}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </Card>
  );
}

export function GeneralProfitAndLoss({ pl, prev, prevLabel }: { pl: GroupedProfitAndLossReport; prev?: GroupedProfitAndLossReport | null; prevLabel?: string }) {
  const cols = prev ? 3 : 2;
  const ledger = { from: pl.from, to: pl.to };
  const p = prev ?? undefined;
  return (
    <StatementTable prevLabel={prev ? prevLabel : undefined}>
      <GroupRows g={pl.operatingIncome} prev={p?.operatingIncome} depth={0} ledger={ledger} cols={cols} />
      <GroupRows g={pl.costOfGoodsSold} prev={p?.costOfGoodsSold} depth={0} ledger={ledger} cols={cols} />
      <ResultRow label="Gross Profit" value={pl.grossProfitPaise} before={p?.grossProfitPaise} cols={cols} />
      <GroupRows g={pl.operatingExpense} prev={p?.operatingExpense} depth={0} ledger={ledger} cols={cols} />
      <ResultRow label="Operating Profit" value={pl.operatingProfitPaise} before={p?.operatingProfitPaise} cols={cols} />
      <GroupRows g={pl.nonOperatingIncome} prev={p?.nonOperatingIncome} depth={0} ledger={ledger} cols={cols} />
      <GroupRows g={pl.nonOperatingExpense} prev={p?.nonOperatingExpense} depth={0} ledger={ledger} cols={cols} />
      <ResultRow label={pl.netProfitPaise >= 0 ? 'Net Profit' : 'Net Loss'} value={pl.netProfitPaise} before={p?.netProfitPaise} cols={cols} strong />
    </StatementTable>
  );
}

export function GeneralBalanceSheet({ bs, prev, prevLabel }: { bs: GroupedBalanceSheetReport; prev?: GroupedBalanceSheetReport | null; prevLabel?: string }) {
  const cols = prev ? 3 : 2;
  const ledger = { from: bs.fyStart, to: bs.asOf };
  const p = prev ?? undefined;
  return (
    <StatementTable prevLabel={prev ? prevLabel : undefined}>
      <GroupRows g={bs.assets} prev={p?.assets} depth={0} ledger={ledger} cols={cols} />
      <tr className="bg-muted/40"><td colSpan={cols} className="px-4 py-2 text-sm font-semibold">Liabilities &amp; Equities</td></tr>
      <GroupRows g={bs.liabilities} prev={p?.liabilities} depth={1} ledger={ledger} cols={cols} />
      <GroupRows g={bs.equities} prev={p?.equities} depth={1} ledger={ledger} cols={cols} />
      <ResultRow label="Total for Liabilities & Equities" value={bs.totalLiabilitiesAndEquitiesPaise} before={p?.totalLiabilitiesAndEquitiesPaise} cols={cols} />
    </StatementTable>
  );
}

// ── Horizontal (T-form) ──────────────────────────────────────────────────────

interface TRow { label: string; amountPaise?: number; sub?: { name: string; amountPaise: number; href?: string }[]; strong?: boolean; muted?: boolean }

function subsOf(g: StatementGroup, ledger: { from: string; to: string }, sign = 1): TRow['sub'] {
  const flat = (x: StatementGroup): StatementGroup['lines'] => [...x.lines, ...(x.groups ?? []).flatMap(flat)];
  return flat(g).map((l) => ({ name: l.name, amountPaise: sign * l.amountPaise, href: l.code ? ledgerHref(l.accountId, ledger.from, ledger.to) : undefined }));
}

function Side({ title, rows, total }: { title: string; rows: TRow[]; total: number }) {
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex border-b bg-muted/60 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span className="flex-1">{title}</span>
        <span>Amount</span>
      </div>
      <div className="flex-1">
        {rows.map((r, i) => (
          <div key={`${r.label}-${i}`} className={cn('border-b border-dashed px-4 py-2 last:border-0', r.strong && 'bg-muted/25 font-semibold')}>
            <div className="flex items-baseline gap-3">
              <span className={cn('min-w-0 flex-1 text-sm', r.muted && 'italic text-muted-foreground')}>{r.label}</span>
              {r.amountPaise !== undefined && <Money value={r.amountPaise} className="text-sm" />}
            </div>
            {r.sub && r.sub.length > 0 && (
              <div className="mt-1 space-y-0.5 pl-4">
                {r.sub.map((s, j) => (
                  <div key={`${s.name}-${j}`} className="flex items-baseline gap-3 text-xs text-muted-foreground">
                    <span className="min-w-0 flex-1 truncate">
                      {s.href ? <Link href={s.href} className="hover:text-foreground hover:underline">{s.name}</Link> : s.name}
                    </span>
                    <Money value={s.amountPaise} />
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="flex border-t-2 bg-muted/50 px-4 py-2.5 text-sm font-semibold">
        <span className="flex-1">Total</span>
        <Money value={total} />
      </div>
    </div>
  );
}

function TForm({ left, right }: { left: { title: string; rows: TRow[]; total: number }; right: { title: string; rows: TRow[]; total: number } }) {
  return (
    <Card className="grid overflow-hidden p-0 md:grid-cols-2 md:divide-x">
      <Side {...left} />
      <Side {...right} />
    </Card>
  );
}

/**
 * The trading and profit and loss account, side by side. The trading part
 * balances on gross profit (or loss), carried down to the profit and loss
 * part, which balances on net profit (or loss).
 */
export function horizontalProfitAndLoss(pl: GroupedProfitAndLossReport) {
  const ledger = { from: pl.from, to: pl.to };
  const direct = { ...pl.costOfGoodsSold, lines: pl.costOfGoodsSold.lines.filter((l) => l.accountId !== 'opening-stock' && l.accountId !== 'closing-stock') };
  const directTotal = direct.lines.reduce((t, l) => t + l.amountPaise, 0);
  const gp = pl.grossProfitPaise;
  const tradingDr = pl.openingStockPaise + directTotal + Math.max(0, gp);
  const tradingCr = pl.operatingIncome.totalPaise + pl.closingStockPaise + Math.max(0, -gp);
  const indirectExp = pl.operatingExpense.totalPaise + pl.nonOperatingExpense.totalPaise;
  const np = pl.netProfitPaise;
  const plDr = Math.max(0, -gp) + indirectExp + Math.max(0, np);
  const plCr = Math.max(0, gp) + pl.nonOperatingIncome.totalPaise + Math.max(0, -np);

  // The trading account first, closed by its total; then the profit and loss
  // account, which the side totals below close.
  const left: TRow[] = [
    { label: 'To Opening Stock', amountPaise: pl.openingStockPaise },
    { label: 'To Purchases and Direct Expenses', amountPaise: directTotal, sub: subsOf(direct, ledger) },
    gp >= 0 ? { label: 'To Gross Profit c/d', amountPaise: gp, strong: true } : { label: '', muted: true },
    { label: 'Total', amountPaise: tradingDr, strong: true },
    ...(gp < 0 ? [{ label: 'To Gross Loss b/d', amountPaise: -gp }] : []),
    { label: 'To Indirect Expenses', amountPaise: indirectExp, sub: [...(subsOf(pl.operatingExpense, ledger) ?? []), ...(subsOf(pl.nonOperatingExpense, ledger) ?? [])] },
    ...(np >= 0 ? [{ label: 'To Net Profit', amountPaise: np, strong: true }] : []),
  ];
  const right: TRow[] = [
    { label: 'By Sales and Operating Income', amountPaise: pl.operatingIncome.totalPaise, sub: subsOf(pl.operatingIncome, ledger) },
    { label: 'By Closing Stock', amountPaise: pl.closingStockPaise },
    gp < 0 ? { label: 'By Gross Loss c/d', amountPaise: -gp, strong: true } : { label: '', muted: true },
    { label: 'Total', amountPaise: tradingCr, strong: true },
    ...(gp >= 0 ? [{ label: 'By Gross Profit b/d', amountPaise: gp }] : []),
    { label: 'By Indirect Income', amountPaise: pl.nonOperatingIncome.totalPaise, sub: subsOf(pl.nonOperatingIncome, ledger) },
    ...(np < 0 ? [{ label: 'By Net Loss', amountPaise: -np, strong: true }] : []),
  ];
  return { left, right, tradingDr, tradingCr, plDr, plCr };
}

export function HorizontalProfitAndLoss({ pl }: { pl: GroupedProfitAndLossReport }) {
  const h = horizontalProfitAndLoss(pl);
  return (
    <div className="space-y-2">
      <TForm
        left={{ title: 'Particulars (Dr)', rows: h.left, total: h.plDr }}
        right={{ title: 'Particulars (Cr)', rows: h.right, total: h.plCr }}
      />
      <p className="text-xs text-muted-foreground">
        The trading account closes at its total (<Money value={h.tradingDr} />) and carries the gross {pl.grossProfitPaise >= 0 ? 'profit' : 'loss'} down to the profit and loss account, which closes at <Money value={h.plDr} />.
      </p>
    </div>
  );
}

/** Liabilities and equities on the left, assets on the right, as a Tally balance sheet reads. */
export function horizontalBalanceSheet(bs: GroupedBalanceSheetReport) {
  const ledger = { from: bs.fyStart, to: bs.asOf };
  const child = (g: StatementGroup, key: string) => (g.groups ?? []).find((c) => c.key === key)!;
  const current = child(bs.assets, 'current-assets');
  const currentLiab = child(bs.liabilities, 'current-liabilities');
  const left: TRow[] = [
    { label: 'Capital Account (Equities)', amountPaise: bs.equities.totalPaise, sub: subsOf(bs.equities, ledger) },
    { label: 'Long Term Liabilities (Loans)', amountPaise: child(bs.liabilities, 'long-term-liabilities').totalPaise, sub: subsOf(child(bs.liabilities, 'long-term-liabilities'), ledger) },
    { label: 'Current Liabilities', amountPaise: currentLiab.totalPaise, sub: subsOf(currentLiab, ledger) },
    { label: 'Other Liabilities', amountPaise: child(bs.liabilities, 'other-liabilities').totalPaise, sub: subsOf(child(bs.liabilities, 'other-liabilities'), ledger) },
  ];
  const right: TRow[] = [
    { label: 'Fixed Assets', amountPaise: child(bs.assets, 'fixed-assets').totalPaise, sub: subsOf(child(bs.assets, 'fixed-assets'), ledger) },
    { label: 'Other Assets (Investments, Deposits)', amountPaise: child(bs.assets, 'other-assets').totalPaise, sub: subsOf(child(bs.assets, 'other-assets'), ledger) },
    { label: 'Current Assets', amountPaise: current.totalPaise, sub: subsOf(current, ledger) },
  ];
  return { left, right };
}

export function HorizontalBalanceSheet({ bs }: { bs: GroupedBalanceSheetReport }) {
  const h = horizontalBalanceSheet(bs);
  return (
    <TForm
      left={{ title: 'Liabilities & Equities', rows: h.left, total: bs.totalLiabilitiesAndEquitiesPaise }}
      right={{ title: 'Assets', rows: h.right, total: bs.assets.totalPaise }}
    />
  );
}

// ── Exports ──────────────────────────────────────────────────────────────────

const flatRows = (g: StatementGroup, depth = 0): (string | number)[][] => [
  [`${'  '.repeat(depth)}${g.label}`, ''],
  ...g.lines.map((l) => [`${'  '.repeat(depth + 1)}${l.name}${l.code ? ` (${l.code})` : ''}`, toRupees(l.amountPaise)]),
  ...(g.groups ?? []).flatMap((c) => flatRows(c, depth + 1)),
  [`${'  '.repeat(depth)}Total for ${g.label}`, toRupees(g.totalPaise)],
];

export function profitAndLossRows(pl: GroupedProfitAndLossReport, format: StatementFormat): (string | number)[][] {
  if (format === 'horizontal') {
    const h = horizontalProfitAndLoss(pl);
    const side = (rows: TRow[]) => rows.flatMap((r) => [[r.label, r.amountPaise === undefined ? '' : toRupees(r.amountPaise)], ...(r.sub ?? []).map((s) => [`    ${s.name}`, toRupees(s.amountPaise)])]);
    const l = side(h.left);
    const r = side(h.right);
    const n = Math.max(l.length, r.length);
    return [
      ['Particulars (Dr)', 'Amount', 'Particulars (Cr)', 'Amount'],
      ...Array.from({ length: n }, (_, i) => [...(l[i] ?? ['', '']), ...(r[i] ?? ['', ''])]),
      ['Total', toRupees(h.plDr), 'Total', toRupees(h.plCr)],
    ];
  }
  return [
    ['Account', 'Total'],
    ...flatRows(pl.operatingIncome),
    ...flatRows(pl.costOfGoodsSold),
    ['Gross Profit', toRupees(pl.grossProfitPaise)],
    ...flatRows(pl.operatingExpense),
    ['Operating Profit', toRupees(pl.operatingProfitPaise)],
    ...flatRows(pl.nonOperatingIncome),
    ...flatRows(pl.nonOperatingExpense),
    [pl.netProfitPaise >= 0 ? 'Net Profit' : 'Net Loss', toRupees(pl.netProfitPaise)],
  ];
}

export function balanceSheetRows(bs: GroupedBalanceSheetReport, format: StatementFormat): (string | number)[][] {
  if (format === 'horizontal') {
    const h = horizontalBalanceSheet(bs);
    const side = (rows: TRow[]) => rows.flatMap((r) => [[r.label, r.amountPaise === undefined ? '' : toRupees(r.amountPaise)], ...(r.sub ?? []).map((s) => [`    ${s.name}`, toRupees(s.amountPaise)])]);
    const l = side(h.left);
    const r = side(h.right);
    const n = Math.max(l.length, r.length);
    return [
      ['Liabilities & Equities', 'Amount', 'Assets', 'Amount'],
      ...Array.from({ length: n }, (_, i) => [...(l[i] ?? ['', '']), ...(r[i] ?? ['', ''])]),
      ['Total', toRupees(bs.totalLiabilitiesAndEquitiesPaise), 'Total', toRupees(bs.assets.totalPaise)],
    ];
  }
  return [
    ['Account', 'Total'],
    ...flatRows(bs.assets),
    ['Liabilities & Equities', ''],
    ...flatRows(bs.liabilities, 1),
    ...flatRows(bs.equities, 1),
    ['Total for Liabilities & Equities', toRupees(bs.totalLiabilitiesAndEquitiesPaise)],
  ];
}
