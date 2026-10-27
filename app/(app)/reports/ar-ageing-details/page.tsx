'use client';

// AR Ageing Details — the invoice-by-invoice version of the ageing summary.
//
// The summary tells you a customer owes ₹4L in the 31–45 bucket; this tells you
// *which* invoice it is, so somebody can go and chase it. Both age from the due
// date, not the invoice date — an invoice on 60-day terms is not "60 days old"
// the moment credit is granted.

import { Badge } from '@/components/ui/badge';
import { Money } from '@/components/shared/money';
import { downloadCsv, ReportShell, useReportRange } from '@/components/shared/report-shell';
import { ReportGrid, gridCsv, type GridColumn } from '@/components/shared/report-grid';
import { AsyncPage } from '@/components/shared/async-state';
import { invoices, type InvoiceListItem, type InvoiceListResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { ageingBucket } from '@/lib/ledger/reports';
import { toRupees } from '@/lib/money';
import { cn } from '@/lib/utils';

interface Row extends InvoiceListItem {
  age: number;
  bucket: string;
}

const short = (d: string) => new Date(d).toLocaleDateString('en-IN');

function aged(d: InvoiceListResponse, asOf: string): Row[] {
  return d.invoices
    .map((i) => ({
      ...i,
      age: Math.floor((new Date(asOf).getTime() - new Date(i.dueDate).getTime()) / 86_400_000),
      bucket: ageingBucket(i.dueDate, asOf) as string,
    }))
    .sort((a, b) => b.age - a.age);
}

const columns: GridColumn<Row>[] = [
  { key: 'date', header: 'Date', cell: (r) => <span className="tabular text-xs">{short(r.date)}</span>, csv: (r) => r.date },
  { key: 'number', header: 'Invoice#', cell: (r) => <span className="font-medium">{r.number}</span>, csv: (r) => r.number },
  { key: 'customer', header: 'Customer', cell: (r) => r.customerName, csv: (r) => r.customerName },
  { key: 'due', header: 'Due Date', cell: (r) => <span className="tabular text-xs">{short(r.dueDate)}</span>, csv: (r) => r.dueDate },
  {
    key: 'age', header: 'Age (days)', align: 'right',
    cell: (r) => (
      <span className={cn('tabular text-xs', r.age > 0 ? 'font-medium text-destructive' : 'text-muted-foreground')}>
        {r.age > 0 ? r.age : '—'}
      </span>
    ),
    csv: (r) => (r.age > 0 ? r.age : 0),
  },
  {
    key: 'bucket', header: 'Bucket',
    cell: (r) => (
      <Badge variant="outline" className={cn('text-[10px]', r.bucket !== 'Current' && 'border-destructive/40 text-destructive')}>
        {r.bucket}
      </Badge>
    ),
    csv: (r) => r.bucket,
  },
  { key: 'total', header: 'Invoice Total', align: 'right', cell: (r) => <Money value={r.totalPaise} />, csv: (r) => toRupees(r.totalPaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.totalPaise, 0)} /> },
  { key: 'balance', header: 'Balance Due', align: 'right', cell: (r) => <Money value={r.balancePaise} />, csv: (r) => toRupees(r.balancePaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.balancePaise, 0)} /> },
];

export default function ArAgeingDetailsPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<InvoiceListResponse>(
    () => invoices.list({ open: true, to: range.to, limit: 500 }),
    [range.to],
  );

  return (
    <ReportShell
      title="AR Ageing Details"
      description="Every unpaid invoice, aged from its due date. The summary tells you how much is late; this tells you which invoice to chase."
      range={range}
      onRangeChange={setRange}
      asOfOnly
      onExport={() => {
        if (state.data) downloadCsv('ar-ageing-details.csv', gridCsv(aged(state.data, range.to), columns));
      }}
    >
      <AsyncPage state={state}>
        {(d) => {
          const rows = aged(d, range.to);
          const overdue = rows.filter((r) => r.age > 0);
          return (
            <>
              <p className="text-xs text-muted-foreground">
                {rows.length} open invoice(s), of which {overdue.length} are past due —{' '}
                <Money value={overdue.reduce((t, r) => t + r.balancePaise, 0)} className="font-medium" /> overdue.
              </p>
              <ReportGrid rows={rows} columns={columns} emptyMessage="Nothing outstanding as at this date." />
            </>
          );
        }}
      </AsyncPage>
    </ReportShell>
  );
}
