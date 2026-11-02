'use client';

// AP Ageing Details — the bill-by-bill version of the payables ageing summary.
// Aged from the due date, as the receivables side is: a bill on 45-day terms
// is not late the day it arrives. MSME suppliers are marked, since paying
// them past 45 days costs interest and the deduction for the expense.

import { Badge } from '@/components/ui/badge';
import { Money } from '@/components/shared/money';
import { downloadCsv, ReportShell, useReportRange } from '@/components/shared/report-shell';
import { ReportGrid, gridCsv, type GridColumn } from '@/components/shared/report-grid';
import { AsyncPage } from '@/components/shared/async-state';
import { bills, type BillListItem, type BillListResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { ageingBucket } from '@/lib/ledger/reports';
import { toRupees } from '@/lib/money';
import { cn } from '@/lib/utils';

interface Row extends BillListItem {
  age: number;
  bucket: string;
}

const short = (d: string) => new Date(d).toLocaleDateString('en-IN');

function aged(d: BillListResponse, asOf: string): Row[] {
  return d.bills
    .map((b) => ({
      ...b,
      age: Math.floor((new Date(asOf).getTime() - new Date(b.dueDate).getTime()) / 86_400_000),
      bucket: ageingBucket(b.dueDate, asOf) as string,
    }))
    .sort((a, b) => b.age - a.age);
}

const columns: GridColumn<Row>[] = [
  { key: 'date', header: 'Date', cell: (r) => <span className="tabular text-xs">{short(r.date)}</span>, csv: (r) => r.date },
  { key: 'number', header: 'Bill#', cell: (r) => <span className="font-medium">{r.internalNo}</span>, csv: (r) => r.internalNo },
  { key: 'vendorRef', header: 'Vendor Invoice#', cell: (r) => <span className="text-xs text-muted-foreground">{r.vendorInvoiceNo}</span>, csv: (r) => r.vendorInvoiceNo },
  {
    key: 'vendor', header: 'Vendor',
    cell: (r) => <span className="flex items-center gap-2">{r.vendorName}{r.isMsme && <Badge variant="outline" className="text-[9px]">MSME</Badge>}</span>,
    csv: (r) => r.vendorName,
  },
  { key: 'due', header: 'Due Date', cell: (r) => <span className="tabular text-xs">{short(r.dueDate)}</span>, csv: (r) => r.dueDate },
  {
    key: 'age', header: 'Age (days)', align: 'right',
    cell: (r) => <span className={cn('tabular text-xs', r.age > 0 ? 'font-medium text-destructive' : 'text-muted-foreground')}>{r.age > 0 ? r.age : '—'}</span>,
    csv: (r) => (r.age > 0 ? r.age : 0),
  },
  {
    key: 'bucket', header: 'Bucket',
    cell: (r) => <Badge variant="outline" className={cn('text-[10px]', r.bucket !== 'Current' && 'border-destructive/40 text-destructive')}>{r.bucket}</Badge>,
    csv: (r) => r.bucket,
  },
  { key: 'total', header: 'Bill Total', align: 'right', cell: (r) => <Money value={r.totalPaise} />, csv: (r) => toRupees(r.totalPaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.totalPaise, 0)} /> },
  { key: 'balance', header: 'Balance Due', align: 'right', cell: (r) => <Money value={r.balancePaise} />, csv: (r) => toRupees(r.balancePaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.balancePaise, 0)} /> },
];

export default function ApAgeingDetailsPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<BillListResponse>(() => bills.list({ open: true, to: range.to, limit: 500 }), [range.to]);

  return (
    <ReportShell
      title="AP Ageing Details"
      description="Every unpaid bill, aged from its due date: which supplier to pay first. MSME suppliers are marked."
      range={range}
      onRangeChange={setRange}
      asOfOnly
      onExport={() => {
        if (state.data) downloadCsv('ap-ageing-details.csv', gridCsv(aged(state.data, range.to), columns));
      }}
    >
      <AsyncPage state={state}>
        {(d) => {
          const rows = aged(d, range.to);
          const overdue = rows.filter((r) => r.age > 0);
          return (
            <>
              <p className="text-xs text-muted-foreground">
                {rows.length} unpaid bill(s), of which {overdue.length} are past due —{' '}
                <Money value={overdue.reduce((t, r) => t + r.balancePaise, 0)} className="font-medium" /> overdue
                {overdue.some((r) => r.isMsme) ? `, ${overdue.filter((r) => r.isMsme).length} of them to MSME suppliers` : ''}.
              </p>
              <ReportGrid rows={rows} columns={columns} emptyMessage="Nothing owed to suppliers as at this date." />
            </>
          );
        }}
      </AsyncPage>
    </ReportShell>
  );
}
