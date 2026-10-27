'use client';

// Confirmed orders and how much of each has been billed.
//
// The gap between the order value and the invoiced column is the backlog: work
// promised but not yet delivered, and so not yet revenue.

import { Money } from '@/components/shared/money';
import { downloadCsv, ReportShell, useReportRange } from '@/components/shared/report-shell';
import { ReportGrid, gridCsv, type GridColumn } from '@/components/shared/report-grid';
import { AsyncPage } from '@/components/shared/async-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { salesDocuments, type SalesDocListResponse, type SalesDocRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';

const short = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN') : '—');

const columns: GridColumn<SalesDocRow>[] = [
  { key: 'date', header: 'Date', cell: (r) => <span className="tabular text-xs">{short(r.date)}</span>, csv: (r) => r.date },
  { key: 'number', header: 'Order#', cell: (r) => <span className="font-medium">{r.number}</span>, csv: (r) => r.number },
  { key: 'customer', header: 'Customer', cell: (r) => r.customerName, csv: (r) => r.customerName },
  { key: 'ship', header: 'Expected Ship', cell: (r) => <span className="tabular text-xs">{short(r.detail)}</span>, csv: (r) => r.detail ?? '' },
  { key: 'invoiced', header: 'Invoiced', align: 'right', cell: (r) => <Money value={r.appliedPaise ?? 0} showZero={false} />, csv: (r) => toRupees(r.appliedPaise ?? 0), total: (rs) => <Money value={rs.reduce((t, r) => t + (r.appliedPaise ?? 0), 0)} /> },
  { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} />, csv: (r) => r.status },
  { key: 'taxable', header: 'Taxable', align: 'right', cell: (r) => <Money value={r.subtotalPaise} />, csv: (r) => toRupees(r.subtotalPaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.subtotalPaise, 0)} /> },
  { key: 'total', header: 'Total', align: 'right', cell: (r) => <Money value={r.totalPaise} className="font-medium" />, csv: (r) => toRupees(r.totalPaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.totalPaise, 0)} /> },
];

export default function SalesOrderDetailsPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<SalesDocListResponse>(
    () => salesDocuments.list('sales-order', { from: range.from, to: range.to, limit: 500 }),
    [range.from, range.to],
  );

  return (
    <ReportShell
      title="Sales Order Details"
      description="Confirmed orders in the period and how much of each has been invoiced. The gap is the backlog still to deliver."
      range={range}
      onRangeChange={setRange}
      onExport={() => {
        if (state.data) downloadCsv('sales-order-details.csv', gridCsv(state.data.documents, columns));
      }}
    >
      <AsyncPage state={state}>
        {(d) => <ReportGrid rows={d.documents} columns={columns} emptyMessage="No sales orders in this period." />}
      </AsyncPage>
    </ReportShell>
  );
}
