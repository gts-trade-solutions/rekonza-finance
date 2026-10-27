'use client';

// The order backlog, line by line: what each order still has to deliver (or
// receive) and to invoice (or bill), and what that is worth. Shared by the
// sales and purchase versions, which differ only in their words.

import { Fragment } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Money } from '@/components/shared/money';
import { AsyncPage } from '@/components/shared/async-state';
import { downloadCsv, ReportShell, ReportTable, useReportRange } from '@/components/shared/report-shell';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';

interface PendingLine {
  lineId: string; description: string; uqc: string | null; ordered: number; moved: number; settled: number;
  toMove: number; toSettle: number; pendingPaise: number;
}
interface PendingOrder {
  id: string; number: string; partyName: string; date: string; expectedDate: string | null; overdue: boolean;
  status: string; lines: PendingLine[]; pendingPaise: number;
}
interface PendingResponse { asOf: string; orders: PendingOrder[]; totalPendingPaise: number; overdue: number }

const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const fmt = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const q = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export function PendingOrdersReport({ kind }: { kind: 'sales' | 'purchase' }) {
  const sales = kind === 'sales';
  const [range, setRange] = useReportRange();
  const report = sales ? 'pending-sales-orders' : 'pending-purchase-orders';
  const state = useApi(() => api.get<PendingResponse>('/api/reports', { report, to: range.to }), [report, range.to]);
  const words = sales
    ? { title: 'Pending Sales Orders', party: 'Customer', moved: 'Delivered', settled: 'Invoiced', toMove: 'To deliver', toSettle: 'To invoice', href: '/sales/sales-orders' }
    : { title: 'Pending Purchase Orders', party: 'Vendor', moved: 'Received', settled: 'Billed', toMove: 'To receive', toSettle: 'To bill', href: '/purchases/purchase-orders' };

  return (
    <ReportShell
      title={words.title}
      description={sales
        ? 'Every open order line with something left to deliver or invoice, and its value. Overdue: past the expected ship date with goods still to go.'
        : 'Every open order line with something left to receive or bill, and its value. Overdue: past the expected date with goods still to come.'}
      range={range}
      onRangeChange={setRange}
      asOfOnly
      onExport={() => {
        if (!state.data) return;
        downloadCsv(`${report}.csv`, [
          ['Order', 'Date', words.party, 'Expected', 'Item', 'Ordered', words.moved, words.settled, words.toMove, words.toSettle, 'Pending value'],
          ...state.data.orders.flatMap((o) => o.lines.map((l) => [
            o.number, o.date, o.partyName, o.expectedDate ?? '', l.description, l.ordered, l.moved, l.settled, l.toMove, l.toSettle, toRupees(l.pendingPaise),
          ])),
        ]);
      }}
    >
      <AsyncPage state={state}>
        {(d) => (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Card className="p-4"><p className="text-xs text-muted-foreground">Open orders</p><p className="mt-1 text-xl font-semibold">{d.orders.length}</p></Card>
              <Card className="p-4"><p className="text-xs text-muted-foreground">Value still to {sales ? 'invoice' : 'bill'}</p><Money value={d.totalPendingPaise} className="mt-1 block text-xl font-semibold" /></Card>
              <Card className={`p-4 ${d.overdue ? 'border-amber-500/40 bg-amber-500/5' : ''}`}><p className="text-xs text-muted-foreground">Overdue</p><p className="mt-1 text-xl font-semibold">{d.overdue}</p></Card>
            </div>
            {d.orders.length === 0 ? (
              <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">Nothing pending.</p>
            ) : (
              <ReportTable>
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className={`${th} text-left`}>Order · item</th>
                    <th className={`${th} text-right`}>Ordered</th>
                    <th className={`${th} text-right`}>{words.moved}</th>
                    <th className={`${th} text-right`}>{words.settled}</th>
                    <th className={`${th} text-right`}>{words.toMove}</th>
                    <th className={`${th} text-right`}>{words.toSettle}</th>
                    <th className={`${th} text-right`}>Pending value</th>
                  </tr>
                </thead>
                <tbody>
                  {d.orders.map((o) => (
                    <Fragment key={o.id}>
                      <tr className="border-b bg-muted/30">
                        <td colSpan={6} className="px-3 py-2 text-sm">
                          <Link href={words.href} className="font-medium hover:underline">{o.number}</Link>
                          <span className="ml-2 text-muted-foreground">{o.partyName} · {fmt(o.date)}{o.expectedDate ? ` · expected ${fmt(o.expectedDate)}` : ''}</span>
                          {o.overdue && <Badge variant="outline" className="ml-2 border-amber-500/40 text-[10px] text-amber-700 dark:text-amber-300">Overdue</Badge>}
                        </td>
                        <td className="px-3 py-2 text-right font-medium"><Money value={o.pendingPaise} /></td>
                      </tr>
                      {o.lines.map((l) => (
                        <tr key={l.lineId} className="border-b last:border-0">
                          <td className="px-3 py-1.5 pl-6 text-sm">{l.description}{l.uqc ? <span className="ml-1 text-xs text-muted-foreground">{l.uqc}</span> : null}</td>
                          <td className="px-3 py-1.5 text-right tabular text-sm">{q(l.ordered)}</td>
                          <td className="px-3 py-1.5 text-right tabular text-sm text-muted-foreground">{q(l.moved)}</td>
                          <td className="px-3 py-1.5 text-right tabular text-sm text-muted-foreground">{q(l.settled)}</td>
                          <td className="px-3 py-1.5 text-right tabular text-sm">{l.toMove ? q(l.toMove) : '—'}</td>
                          <td className="px-3 py-1.5 text-right tabular text-sm font-medium">{q(l.toSettle)}</td>
                          <td className="px-3 py-1.5 text-right"><Money value={l.pendingPaise} /></td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </ReportTable>
            )}
          </div>
        )}
      </AsyncPage>
    </ReportShell>
  );
}
