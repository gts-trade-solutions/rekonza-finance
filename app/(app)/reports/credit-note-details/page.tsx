'use client';

// Every credit note raised in the period.
//
// Each one reversed part of a sale: revenue out, output GST out, receivable down.
// The reason column is not decoration — GSTR-1 reports it.

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
  { key: 'number', header: 'Credit Note#', cell: (r) => <span className="font-medium">{r.number}</span>, csv: (r) => r.number },
  { key: 'customer', header: 'Customer', cell: (r) => r.customerName, csv: (r) => r.customerName },
  { key: 'against', header: 'Against Invoice', cell: (r) => <span className="text-xs">{r.linkedId ? `#${r.linkedId}` : 'Standalone'}</span>, csv: (r) => (r.linkedId ? `#${r.linkedId}` : 'Standalone') },
  { key: 'reason', header: 'Reason', cell: (r) => <span className="text-xs text-muted-foreground">{r.detail}</span>, csv: (r) => r.detail ?? '' },
  { key: 'applied', header: 'Applied', align: 'right', cell: (r) => <Money value={r.appliedPaise ?? 0} showZero={false} />, csv: (r) => toRupees(r.appliedPaise ?? 0), total: (rs) => <Money value={rs.reduce((t, r) => t + (r.appliedPaise ?? 0), 0)} /> },
  { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} />, csv: (r) => r.status },
  { key: 'taxable', header: 'Taxable', align: 'right', cell: (r) => <Money value={r.subtotalPaise} />, csv: (r) => toRupees(r.subtotalPaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.subtotalPaise, 0)} /> },
  { key: 'total', header: 'Total', align: 'right', cell: (r) => <Money value={r.totalPaise} className="font-medium" />, csv: (r) => toRupees(r.totalPaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.totalPaise, 0)} /> },
];

export default function CreditNoteDetailsPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<SalesDocListResponse>(
    () => salesDocuments.list('credit-note', { from: range.from, to: range.to, limit: 500 }),
    [range.from, range.to],
  );

  return (
    <ReportShell
      title="Credit Note Details"
      description="Every credit note in the period, what it was against, and why. The reason is reported in GSTR-1."
      range={range}
      onRangeChange={setRange}
      onExport={() => {
        if (state.data) downloadCsv('credit-note-details.csv', gridCsv(state.data.documents, columns));
      }}
    >
      <AsyncPage state={state}>
        {(d) => <ReportGrid rows={d.documents} columns={columns} emptyMessage="No credit notes in this period." />}
      </AsyncPage>
    </ReportShell>
  );
}
