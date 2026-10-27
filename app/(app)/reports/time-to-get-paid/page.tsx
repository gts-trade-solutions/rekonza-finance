'use client';

// Time to Get Paid.
//
// Ageing tells you what is late right now. This tells you how long you *usually*
// wait, which is a different and more useful question — it is the number that
// says whether your 30-day terms mean anything in practice.

import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Money } from '@/components/shared/money';
import { downloadCsv, ReportShell, useReportRange } from '@/components/shared/report-shell';
import { ReportGrid, gridCsv, type GridColumn } from '@/components/shared/report-grid';
import { AsyncPage } from '@/components/shared/async-state';
import { reports, type TimeToGetPaidReport } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';
import { cn } from '@/lib/utils';

type Row = TimeToGetPaidReport['rows'][number];

const short = (d: string) => new Date(d).toLocaleDateString('en-IN');

const columns: GridColumn<Row>[] = [
  { key: 'number', header: 'Invoice#', cell: (r) => <span className="font-medium">{r.number}</span>, csv: (r) => r.number },
  { key: 'customer', header: 'Customer', cell: (r) => r.customer, csv: (r) => r.customer },
  { key: 'date', header: 'Invoice Date', cell: (r) => <span className="tabular text-xs">{short(r.date)}</span>, csv: (r) => r.date },
  { key: 'due', header: 'Due Date', cell: (r) => <span className="tabular text-xs">{short(r.dueDate)}</span>, csv: (r) => r.dueDate },
  { key: 'settled', header: 'Paid On', cell: (r) => <span className="tabular text-xs">{short(r.settledOn)}</span>, csv: (r) => r.settledOn },
  { key: 'days', header: 'Days Taken', align: 'right', cell: (r) => <span className="tabular text-xs font-medium">{r.days}</span>, csv: (r) => r.days },
  {
    key: 'vsTerms', header: 'Vs Terms', align: 'right',
    cell: (r) => (
      <Badge
        variant="outline"
        className={cn(
          'text-[10px]',
          r.vsTerms > 0
            ? 'border-destructive/40 text-destructive'
            : 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
        )}
      >
        {r.vsTerms > 0 ? `${r.vsTerms} late` : r.vsTerms === 0 ? 'On time' : `${Math.abs(r.vsTerms)} early`}
      </Badge>
    ),
    csv: (r) => r.vsTerms,
  },
  {
    key: 'amount', header: 'Amount', align: 'right',
    cell: (r) => <Money value={r.totalPaise} />,
    csv: (r) => toRupees(r.totalPaise),
    total: (rs) => <Money value={rs.reduce((t, r) => t + r.totalPaise, 0)} />,
  },
];

export default function TimeToGetPaidPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<TimeToGetPaidReport>(
    () => reports.timeToGetPaid(range.from, range.to),
    [range.from, range.to],
  );

  return (
    <ReportShell
      title="Time to Get Paid"
      description="How long invoices actually take to settle, measured from the invoice date to the receipt that cleared them."
      range={range}
      onRangeChange={setRange}
      onExport={() => {
        if (state.data) downloadCsv('time-to-get-paid.csv', gridCsv(state.data.rows, columns));
      }}
    >
      <AsyncPage state={state}>
        {(d) => {
          const n = d.rows.length;
          const kpis = [
            { label: 'Average days to pay', value: n ? d.averageDays.toFixed(1) : '—', hint: 'across settled invoices' },
            { label: 'Paid on time', value: n ? `${d.onTimePct.toFixed(0)}%` : '—', hint: `${d.rows.filter((r) => r.vsTerms <= 0).length} of ${n}` },
            { label: 'Fastest', value: n ? `${Math.min(...d.rows.map((r) => r.days))} days` : '—', hint: 'best case' },
            { label: 'Slowest', value: n ? `${Math.max(...d.rows.map((r) => r.days))} days` : '—', hint: 'worst case' },
          ];
          return (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {kpis.map((k) => (
                  <Card key={k.label} className="p-4">
                    <p className="micro-label">{k.label}</p>
                    <p className="mt-1.5 tabular text-2xl font-semibold">{k.value}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{k.hint}</p>
                  </Card>
                ))}
              </div>

              <p className="text-xs text-muted-foreground">
                Only fully settled invoices appear — a partly paid invoice has no payment date yet, so including
                it would drag the average down with a wait that has not finished. Invoices cleared by a credit note
                rather than cash are excluded for the same reason: no money changed hands.
              </p>

              <ReportGrid rows={d.rows} columns={columns} emptyMessage="No invoices were fully settled in this period." />
            </>
          );
        }}
      </AsyncPage>
    </ReportShell>
  );
}
