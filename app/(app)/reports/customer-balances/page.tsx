'use client';

// What each customer has been invoiced and what is still outstanding.
//
// Computed in SQL over the invoices themselves, so this and the AR ageing are
// two views of one set of documents rather than two independent tallies.

import { Money } from '@/components/shared/money';
import { downloadCsv, ReportShell, useReportRange } from '@/components/shared/report-shell';
import { ReportGrid, gridCsv, type GridColumn } from '@/components/shared/report-grid';
import { AsyncPage } from '@/components/shared/async-state';
import { reports, type PartyBalanceRow, type PartyBalancesReport } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';

const columns: GridColumn<PartyBalanceRow>[] = [
  { key: 'name', header: 'Customer', cell: (r) => <span className="font-medium">{r.name}</span>, csv: (r) => r.name },
  { key: 'gstin', header: 'GSTIN', cell: (r) => <span className="font-mono text-xs">{r.gstin ?? '—'}</span>, csv: (r) => r.gstin ?? '' },
  { key: 'count', header: 'Invoices', align: 'right', cell: (r) => <span className="tabular">{r.documentCount}</span>, csv: (r) => r.documentCount, total: (rs) => <span className="tabular">{rs.reduce((t, r) => t + r.documentCount, 0)}</span> },
  { key: 'invoiced', header: 'Invoiced', align: 'right', cell: (r) => <Money value={r.invoicedPaise} />, csv: (r) => toRupees(r.invoicedPaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.invoicedPaise, 0)} /> },
  { key: 'received', header: 'Received', align: 'right', cell: (r) => <Money value={r.receivedPaise} />, csv: (r) => toRupees(r.receivedPaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.receivedPaise, 0)} /> },
  {
    key: 'balance', header: 'Closing Balance', align: 'right',
    cell: (r) => <Money value={r.outstandingPaise} className={r.outstandingPaise > 0 ? 'font-medium' : 'text-muted-foreground'} />,
    csv: (r) => toRupees(r.outstandingPaise),
    total: (rs) => <Money value={rs.reduce((t, r) => t + r.outstandingPaise, 0)} />,
  },
];

export default function CustomerBalancesPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<PartyBalancesReport>(
    () => reports.partyBalances('customer', range.from, range.to),
    [range.from, range.to],
  );

  return (
    <ReportShell
      title="Customer Balances"
      description="What each customer has been invoiced, what they have paid, and what is still outstanding."
      range={range}
      onRangeChange={setRange}
      onExport={() => {
        if (state.data) downloadCsv('customer-balances.csv', gridCsv(state.data.rows, columns));
      }}
    >
      <AsyncPage state={state}>
        {(d) => <ReportGrid rows={d.rows} columns={columns} emptyMessage="No customer activity in this period." />}
      </AsyncPage>
    </ReportShell>
  );
}
