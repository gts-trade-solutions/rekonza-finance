'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Tally's statements: Trial Balance, Profit & Loss A/c, Balance Sheet and
// Stock Summary, built from the closing balances Tally itself reported.
//
// Laid out as Tally lays them out. The final accounts are in the horizontal
// form — expenses on the left, income on the right; liabilities on the left,
// assets on the right — and every group opens to the ledgers under it, the way
// pressing Enter on a group does in Tally. A ledger opens its vouchers.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { CheckCircle2, ChevronRight, TriangleAlert } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Money } from '@/components/shared/money';
import { ReportTable } from '@/components/shared/report-shell';
import {
  tally, type BalanceSheetView, type FinalLine, type ProfitAndLossView, type StockSummaryView, type TrialBalanceNode,
  type TrialBalanceView,
} from '@/lib/api/tally';
import { useApi } from '@/lib/api/use-api';
import { formatINR } from '@/lib/money';
import { cn } from '@/lib/utils';
import { longDate } from './format';

function AsAt({ asOf, extra }: { asOf: string | null; extra?: string }) {
  return (
    <p className="text-sm text-muted-foreground">
      {asOf ? `As at ${longDate(asOf)}, as Tally reported it on the last sync` : 'Waiting for the first sync'}
      {extra ? ` · ${extra}` : ''}
    </p>
  );
}

function Agreement({ differencePaise, what }: { differencePaise: number; what: string }) {
  const ok = differencePaise === 0;
  return (
    <Card className={cn('flex-row items-center gap-3 p-3 text-sm', ok ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-destructive/40 bg-destructive/5')}>
      {ok ? (
        <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <TriangleAlert className="size-4 shrink-0 text-destructive" />
      )}
      <p>{ok ? `${what} agree.` : `Difference in opening balances: ${formatINR(Math.abs(differencePaise))}. Check the openings in Tally.`}</p>
    </Card>
  );
}

// ── Trial balance ────────────────────────────────────────────────────────────

export function TrialBalance({ companyId, onOpenLedger }: { companyId: string; onOpenLedger: (id: string) => void }) {
  const state = useApi<TrialBalanceView>(() => tally.trialBalance(companyId), [companyId]);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const rows = (nodes: TrialBalanceNode[], depth: number, path: string): React.ReactNode[] =>
    nodes.flatMap((n) => {
      const key = `${path}/${n.name}`;
      const expandable = n.kind === 'group' && n.children.length > 0;
      const expanded = open.has(key);
      const row = (
        <tr
          key={key}
          className={cn('border-b last:border-0', (expandable || n.ledgerId) && 'cursor-pointer hover:bg-accent/40', depth === 0 && 'font-medium')}
          onClick={() => {
            if (n.ledgerId) onOpenLedger(n.ledgerId);
            else if (expandable)
              setOpen((s) => {
                const next = new Set(s);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              });
          }}
        >
          <td className="px-4 py-2" style={{ paddingLeft: `${1 + depth * 1.25}rem` }}>
            <span className="flex items-center gap-1.5">
              {expandable ? (
                <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
              ) : (
                <span className="w-3.5 shrink-0" />
              )}
              <span className={cn(n.kind === 'ledger' && depth > 0 && 'text-muted-foreground')}>{n.name}</span>
            </span>
          </td>
          <td className="px-4 py-2 text-right">{n.debitPaise ? <Money value={n.debitPaise} /> : ''}</td>
          <td className="px-4 py-2 text-right">{n.creditPaise ? <Money value={n.creditPaise} /> : ''}</td>
        </tr>
      );
      return expandable && expanded ? [row, ...rows(n.children, depth + 1, key)] : [row];
    });

  return (
    <div className="space-y-3" data-slot="tally-trial-balance">
      <AsyncPage state={state} loading={<LoadingRows rows={12} />}>
        {(d) => (
          <>
            <AsAt asOf={d.asOf} extra="open a group to see its ledgers" />
            <Agreement differencePaise={d.differencePaise} what="Debits and credits" />
            <ReportTable>
              <thead>
                <tr className="border-b bg-muted/50 text-xs text-muted-foreground">
                  <th className="px-4 py-2.5 text-left font-semibold">Particulars</th>
                  <th className="w-44 px-4 py-2.5 text-right font-semibold">Debit</th>
                  <th className="w-44 px-4 py-2.5 text-right font-semibold">Credit</th>
                </tr>
              </thead>
              <tbody>
                {rows(d.rows, 0, '')}
                <tr className="border-t-2 bg-muted/40 font-semibold">
                  <td className="px-4 py-3">Grand Total</td>
                  <td className="px-4 py-3 text-right"><Money value={d.totalDebitPaise} /></td>
                  <td className="px-4 py-3 text-right"><Money value={d.totalCreditPaise} /></td>
                </tr>
              </tbody>
            </ReportTable>
          </>
        )}
      </AsyncPage>
    </div>
  );
}

// ── The horizontal final accounts ────────────────────────────────────────────

function Side({
  title,
  lines,
  totalPaise,
  onOpenLedger,
  emphasise,
}: {
  title: string;
  lines: FinalLine[];
  totalPaise: number;
  onOpenLedger: (id: string) => void;
  /** Lines carried to the other half — gross and nett profit — are set apart. */
  emphasise: (name: string) => boolean;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex border-b bg-muted/50 px-4 py-2.5 text-xs font-semibold text-muted-foreground">
        <span className="flex-1">{title}</span>
        <span>Amount</span>
      </div>
      <div className="flex-1">
        {lines.map((l) => {
          const expanded = open.has(l.name);
          const expandable = l.children.length > 0;
          return (
            <div key={l.name} className="border-b last:border-0">
              <button
                type="button"
                disabled={!expandable && !l.ledgerId}
                onClick={() => {
                  if (l.ledgerId) onOpenLedger(l.ledgerId);
                  else
                    setOpen((s) => {
                      const next = new Set(s);
                      if (next.has(l.name)) next.delete(l.name);
                      else next.add(l.name);
                      return next;
                    });
                }}
                className={cn(
                  'flex w-full items-center gap-1.5 px-4 py-2 text-left text-sm enabled:hover:bg-accent/40',
                  emphasise(l.name) && 'bg-primary/[0.04] font-semibold',
                )}
              >
                {expandable ? (
                  <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
                ) : (
                  <span className="w-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate font-medium">{l.name}</span>
                <Money value={l.amountPaise} />
              </button>
              {expanded &&
                l.children.map((c) => (
                  <button
                    type="button"
                    key={c.name}
                    disabled={!c.ledgerId}
                    onClick={() => c.ledgerId && onOpenLedger(c.ledgerId)}
                    className="flex w-full items-center gap-1.5 py-1.5 pl-10 pr-4 text-left text-xs text-muted-foreground enabled:hover:bg-accent/40 enabled:hover:text-foreground"
                  >
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                    <Money value={c.amountPaise} />
                  </button>
                ))}
            </div>
          );
        })}
      </div>
      <div className="flex border-t-2 bg-muted/40 px-4 py-2.5 text-sm font-semibold">
        <span className="flex-1">Total</span>
        <Money value={totalPaise} />
      </div>
    </div>
  );
}

const carried = (name: string) => /Gross (Profit|Loss)|Nett (Profit|Loss)/.test(name);

export function ProfitAndLoss({ companyId, onOpenLedger }: { companyId: string; onOpenLedger: (id: string) => void }) {
  const state = useApi<ProfitAndLossView>(() => tally.profitAndLoss(companyId), [companyId]);
  return (
    <div className="space-y-3" data-slot="tally-profit-loss">
      <AsyncPage state={state} loading={<LoadingRows rows={12} />}>
        {(d) => (
          <>
            <AsAt asOf={d.asOf} extra={`for the year from ${longDate(d.fyFrom)}`} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Card className="p-4">
                <p className="micro-label">Gross {d.grossProfitPaise >= 0 ? 'profit' : 'loss'}</p>
                <p className="mt-1 text-2xl font-semibold">{formatINR(Math.abs(d.grossProfitPaise))}</p>
              </Card>
              <Card className={cn('p-4', d.netProfitPaise >= 0 ? 'border-emerald-500/40' : 'border-destructive/40')}>
                <p className="micro-label">Nett {d.netProfitPaise >= 0 ? 'profit' : 'loss'}</p>
                <p className={cn('mt-1 text-2xl font-semibold', d.netProfitPaise < 0 && 'text-destructive')}>
                  {formatINR(Math.abs(d.netProfitPaise))}
                </p>
              </Card>
            </div>
            <Card className="overflow-hidden p-0">
              <div className="grid md:grid-cols-2 md:divide-x">
                <Side title="Particulars" lines={d.trading.debit} totalPaise={d.trading.totalPaise} onOpenLedger={onOpenLedger} emphasise={carried} />
                <Side title="Particulars" lines={d.trading.credit} totalPaise={d.trading.totalPaise} onOpenLedger={onOpenLedger} emphasise={carried} />
              </div>
              <div className="grid border-t-4 border-double md:grid-cols-2 md:divide-x">
                <Side title="Particulars" lines={d.profitAndLoss.debit} totalPaise={d.profitAndLoss.totalPaise} onOpenLedger={onOpenLedger} emphasise={carried} />
                <Side title="Particulars" lines={d.profitAndLoss.credit} totalPaise={d.profitAndLoss.totalPaise} onOpenLedger={onOpenLedger} emphasise={carried} />
              </div>
            </Card>
            <p className="text-xs text-muted-foreground">
              Opening and closing stock come from Tally&apos;s {d.stock.from}. Open a group to see its ledgers; open a ledger to see
              its vouchers.
            </p>
          </>
        )}
      </AsyncPage>
    </div>
  );
}

export function BalanceSheet({ companyId, onOpenLedger }: { companyId: string; onOpenLedger: (id: string) => void }) {
  const state = useApi<BalanceSheetView>(() => tally.balanceSheet(companyId), [companyId]);
  return (
    <div className="space-y-3" data-slot="tally-balance-sheet">
      <AsyncPage state={state} loading={<LoadingRows rows={12} />}>
        {(d) => (
          <>
            <AsAt asOf={d.asOf} />
            <Agreement differencePaise={d.differencePaise} what="Assets and liabilities" />
            <Card className="overflow-hidden p-0">
              <div className="grid md:grid-cols-2 md:divide-x">
                <Side title="Liabilities" lines={d.liabilities} totalPaise={d.totalLiabilitiesPaise} onOpenLedger={onOpenLedger} emphasise={() => false} />
                <Side title="Assets" lines={d.assets} totalPaise={d.totalAssetsPaise} onOpenLedger={onOpenLedger} emphasise={() => false} />
              </div>
            </Card>
          </>
        )}
      </AsyncPage>
    </div>
  );
}

// ── Stock summary ────────────────────────────────────────────────────────────

export function StockSummary({ companyId }: { companyId: string }) {
  const state = useApi<StockSummaryView>(() => tally.stock(companyId), [companyId]);
  return (
    <div className="space-y-3" data-slot="tally-stock">
      <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
        {(d) =>
          d.groups.length === 0 ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">This company keeps no stock items in Tally.</Card>
          ) : (
            <>
              <AsAt asOf={d.asOf} extra="closing quantity and value" />
              <ReportTable>
                <thead>
                  <tr className="border-b bg-muted/50 text-xs text-muted-foreground">
                    <th className="px-4 py-2.5 text-left font-semibold">Particulars</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Quantity</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Rate</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {d.groups.map((g) => [
                    <tr key={`g-${g.name}`} className="border-b bg-muted/20 font-medium">
                      <td className="px-4 py-2" colSpan={3}>
                        {g.name}
                      </td>
                      <td className="px-4 py-2 text-right"><Money value={g.totalValuePaise} /></td>
                    </tr>,
                    ...g.items.map((i) => (
                      <tr key={i.id} className="border-b last:border-0">
                        <td className="py-2 pl-8 pr-4">{i.name}</td>
                        <td className="num px-4 py-2 text-right">
                          {i.closingQty.toLocaleString('en-IN')} {i.unit ?? ''}
                        </td>
                        <td className="px-4 py-2 text-right">{i.ratePaise !== null ? <Money value={i.ratePaise} /> : '—'}</td>
                        <td className="px-4 py-2 text-right"><Money value={i.closingValuePaise} /></td>
                      </tr>
                    )),
                  ])}
                  <tr className="border-t-2 bg-muted/40 font-semibold">
                    <td className="px-4 py-3" colSpan={3}>
                      Grand Total
                    </td>
                    <td className="px-4 py-3 text-right"><Money value={d.totalValuePaise} /></td>
                  </tr>
                </tbody>
              </ReportTable>
            </>
          )
        }
      </AsyncPage>
    </div>
  );
}
