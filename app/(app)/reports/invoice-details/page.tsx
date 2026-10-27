'use client';

// Every invoice raised in the period, from the same query the list screen uses.

import { Money } from '@/components/shared/money';
import { downloadCsv, ReportShell, useReportRange } from '@/components/shared/report-shell';
import { ReportGrid, gridCsv, type GridColumn } from '@/components/shared/report-grid';
import { AsyncPage } from '@/components/shared/async-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { invoices, type InvoiceListItem, type InvoiceListResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';

const short = (d: string) => new Date(d).toLocaleDateString('en-IN');

const columns: GridColumn<InvoiceListItem>[] = [
  { key: 'date', header: 'Date', cell: (r) => <span className="tabular text-xs">{short(r.date)}</span>, csv: (r) => r.date },
  { key: 'number', header: 'Invoice#', cell: (r) => <span className="font-medium">{r.number}</span>, csv: (r) => r.number },
  { key: 'customer', header: 'Customer', cell: (r) => r.customerName, csv: (r) => r.customerName },
  { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} />, csv: (r) => r.status },
  { key: 'due', header: 'Due Date', cell: (r) => <span className="tabular text-xs">{short(r.dueDate)}</span>, csv: (r) => r.dueDate },
  { key: 'taxable', header: 'Taxable', align: 'right', cell: (r) => <Money value={r.subtotalPaise} />, csv: (r) => toRupees(r.subtotalPaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.subtotalPaise, 0)} /> },
  { key: 'total', header: 'Total', align: 'right', cell: (r) => <Money value={r.totalPaise} />, csv: (r) => toRupees(r.totalPaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.totalPaise, 0)} /> },
  { key: 'balance', header: 'Balance Due', align: 'right', cell: (r) => <Money value={r.balancePaise} showZero={false} />, csv: (r) => toRupees(r.balancePaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.balancePaise, 0)} /> },
];

export default function InvoiceDetailsPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<InvoiceListResponse>(
    () => invoices.list({ from: range.from, to: range.to, limit: 500 }),
    [range.from, range.to],
  );

  return (
    <ReportShell
      title="Invoice Details"
      description="Every invoice raised in the period, with its status and outstanding balance."
      range={range}
      onRangeChange={setRange}
      onExport={() => {
        if (state.data) downloadCsv('invoice-details.csv', gridCsv(state.data.invoices, columns));
      }}
    >
      <AsyncPage state={state}>
        {(d) => <ReportGrid rows={d.invoices} columns={columns} emptyMessage="No invoices in this period." />}
      </AsyncPage>
    </ReportShell>
  );
}
