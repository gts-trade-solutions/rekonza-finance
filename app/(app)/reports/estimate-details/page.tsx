'use client';

// Every quote raised in the period, and what became of it.
//
// None of these figures appears in any financial statement. A quote is an offer,
// not a sale — the value here is the pipeline, not the books.

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
  { key: 'number', header: 'Quote#', cell: (r) => <span className="font-medium">{r.number}</span>, csv: (r) => r.number },
  { key: 'customer', header: 'Customer', cell: (r) => r.customerName, csv: (r) => r.customerName },
  { key: 'expiry', header: 'Valid Until', cell: (r) => <span className="tabular text-xs">{short(r.expiry)}</span>, csv: (r) => r.expiry ?? '' },
  { key: 'converted', header: 'Converted To', cell: (r) => <span className="text-xs">{r.detail ? `${r.detail.replace('_', ' ')} #${r.linkedId}` : '—'}</span>, csv: (r) => (r.detail ? `${r.detail} ${r.linkedId}` : '') },
  { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} />, csv: (r) => r.status },
  { key: 'taxable', header: 'Taxable', align: 'right', cell: (r) => <Money value={r.subtotalPaise} />, csv: (r) => toRupees(r.subtotalPaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.subtotalPaise, 0)} /> },
  { key: 'total', header: 'Total', align: 'right', cell: (r) => <Money value={r.totalPaise} className="font-medium" />, csv: (r) => toRupees(r.totalPaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.totalPaise, 0)} /> },
];

export default function EstimateDetailsPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<SalesDocListResponse>(
    () => salesDocuments.list('estimate', { from: range.from, to: range.to, limit: 500 }),
    [range.from, range.to],
  );

  return (
    <ReportShell
      title="Estimate Details"
      description="Every quote raised in the period, with its expiry and whether it converted. Nothing here has touched the ledger."
      range={range}
      onRangeChange={setRange}
      onExport={() => {
        if (state.data) downloadCsv('estimate-details.csv', gridCsv(state.data.documents, columns));
      }}
    >
      <AsyncPage state={state}>
        {(d) => <ReportGrid rows={d.documents} columns={columns} emptyMessage="No estimates in this period." />}
      </AsyncPage>
    </ReportShell>
  );
}
