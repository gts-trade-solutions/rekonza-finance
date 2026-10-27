'use client';

// Retainers, and how much of each has actually been earned.
//
// Three columns that are easy to conflate. The amount is what was billed;
// received is what the customer has paid; earned is how much of that has since
// been consumed by real invoices. Only the last one is income — the rest is
// still sitting in unearned revenue as a liability.

import { Money } from '@/components/shared/money';
import { Card } from '@/components/ui/card';
import { downloadCsv, ReportShell, useReportRange } from '@/components/shared/report-shell';
import { ReportGrid, gridCsv, type GridColumn } from '@/components/shared/report-grid';
import { AsyncPage } from '@/components/shared/async-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { salesDocuments, type SalesDocListResponse, type SalesDocRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';

const short = (d: string) => new Date(d).toLocaleDateString('en-IN');
const held = (r: SalesDocRow) => (r.paidPaise ?? 0) - (r.appliedPaise ?? 0);

const columns: GridColumn<SalesDocRow>[] = [
  { key: 'date', header: 'Date', cell: (r) => <span className="tabular text-xs">{short(r.date)}</span>, csv: (r) => r.date },
  { key: 'number', header: 'Retainer#', cell: (r) => <span className="font-medium">{r.number}</span>, csv: (r) => r.number },
  { key: 'customer', header: 'Customer', cell: (r) => r.customerName, csv: (r) => r.customerName },
  { key: 'description', header: 'For', cell: (r) => <span className="text-xs text-muted-foreground">{r.detail}</span>, csv: (r) => r.detail ?? '' },
  { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} />, csv: (r) => r.status },
  { key: 'amount', header: 'Billed', align: 'right', cell: (r) => <Money value={r.totalPaise} />, csv: (r) => toRupees(r.totalPaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.totalPaise, 0)} /> },
  { key: 'paid', header: 'Received', align: 'right', cell: (r) => <Money value={r.paidPaise ?? 0} showZero={false} />, csv: (r) => toRupees(r.paidPaise ?? 0), total: (rs) => <Money value={rs.reduce((t, r) => t + (r.paidPaise ?? 0), 0)} /> },
  { key: 'applied', header: 'Earned', align: 'right', cell: (r) => <Money value={r.appliedPaise ?? 0} showZero={false} />, csv: (r) => toRupees(r.appliedPaise ?? 0), total: (rs) => <Money value={rs.reduce((t, r) => t + (r.appliedPaise ?? 0), 0)} /> },
  { key: 'held', header: 'Still Held', align: 'right', cell: (r) => <Money value={held(r)} className="font-medium" showZero={false} />, csv: (r) => toRupees(held(r)), total: (rs) => <Money value={rs.reduce((t, r) => t + held(r), 0)} /> },
];

export default function RetainerDetailsPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<SalesDocListResponse>(
    () => salesDocuments.list('retainer', { from: range.from, to: range.to, limit: 500 }),
    [range.from, range.to],
  );

  return (
    <ReportShell
      title="Retainer Details"
      description="Advances billed, what has been received, and how much of that has actually been earned."
      range={range}
      onRangeChange={setRange}
      onExport={() => {
        if (state.data) downloadCsv('retainer-details.csv', gridCsv(state.data.documents, columns));
      }}
    >
      <AsyncPage state={state}>
        {(d) => {
          const stillHeld = d.documents.reduce((t, r) => t + held(r), 0);
          const unpaid = d.documents.reduce(
            (t, r) => t + Math.max(0, r.totalPaise - (r.paidPaise ?? 0)),
            0,
          );
          return (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Card className="p-4">
                  <p className="micro-label">Held as unearned revenue</p>
                  <Money value={stillHeld} className="mt-1 block text-2xl font-semibold" />
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Money received but not yet earned — a liability, not income.
                  </p>
                </Card>
                <Card className="p-4">
                  <p className="micro-label">Billed but not received</p>
                  <Money value={unpaid} className="mt-1 block text-2xl font-semibold" />
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Sitting in receivables like any other unpaid invoice.
                  </p>
                </Card>
              </div>
              <ReportGrid rows={d.documents} columns={columns} emptyMessage="No retainers in this period." />
            </>
          );
        }}
      </AsyncPage>
    </ReportShell>
  );
}
