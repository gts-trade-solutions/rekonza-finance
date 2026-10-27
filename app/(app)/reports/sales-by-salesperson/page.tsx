'use client';

// Who booked the revenue.
//
// Invoices with nobody assigned simply do not appear — the join needs a
// salesperson. That is deliberate: an "Unassigned" row that dwarfs everyone
// else says nothing useful about anyone’s performance.

import { Money } from '@/components/shared/money';
import { downloadCsv, ReportShell, useReportRange } from '@/components/shared/report-shell';
import { ReportGrid, gridCsv, type GridColumn } from '@/components/shared/report-grid';
import { AsyncPage } from '@/components/shared/async-state';
import { reports, type SalesByReport, type SalesByRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';

const columns: GridColumn<SalesByRow>[] = [
  { key: 'name', header: 'Salesperson', cell: (r) => <span className="font-medium">{r.name}</span>, csv: (r) => r.name },
  { key: 'detail', header: 'Email', cell: (r) => <span className="text-xs text-muted-foreground">{r.detail ?? '—'}</span>, csv: (r) => r.detail ?? '' },
  { key: 'count', header: 'Invoices', align: 'right', cell: (r) => <span className="tabular">{r.count}</span>, csv: (r) => r.count, total: (rs) => <span className="tabular">{rs.reduce((t, r) => t + r.count, 0)}</span> },
  { key: 'taxable', header: 'Net Sales', align: 'right', cell: (r) => <Money value={r.taxablePaise} className="font-medium" />, csv: (r) => toRupees(r.taxablePaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.taxablePaise, 0)} /> },
  { key: 'tax', header: 'GST', align: 'right', cell: (r) => <Money value={r.taxPaise} />, csv: (r) => toRupees(r.taxPaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.taxPaise, 0)} /> },
  { key: 'total', header: 'Invoiced', align: 'right', cell: (r) => <Money value={r.totalPaise} />, csv: (r) => toRupees(r.totalPaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.totalPaise, 0)} /> },
];

export default function SalesBySalespersonPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<SalesByReport>(
    () => reports.salesBy('salesperson', range.from, range.to),
    [range.from, range.to],
  );

  return (
    <ReportShell
      title="Sales by Salesperson"
      description="Who booked the revenue in this period. Invoices raised without a salesperson on them are not counted here."
      range={range}
      onRangeChange={setRange}
      onExport={() => {
        if (state.data) downloadCsv('sales-by-salesperson.csv', gridCsv(state.data.rows, columns));
      }}
    >
      <AsyncPage state={state}>
        {(d) => (
          <ReportGrid
            rows={d.rows}
            columns={columns}
            emptyMessage="No invoices in this period have a salesperson assigned."
          />
        )}
      </AsyncPage>
    </ReportShell>
  );
}
