'use client';

// The vendor mirror of customer balances: billed, paid, still owed.
//
// MSME suppliers are flagged because the 45-day rule under section 43B(h)
// applies to them, and a large open balance against one is a tax problem as
// well as a cash-flow one.

import { Money } from '@/components/shared/money';
import { Badge } from '@/components/ui/badge';
import { downloadCsv, ReportShell, useReportRange } from '@/components/shared/report-shell';
import { ReportGrid, gridCsv, type GridColumn } from '@/components/shared/report-grid';
import { AsyncPage } from '@/components/shared/async-state';
import { reports, type PartyBalanceRow, type PartyBalancesReport } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';

const columns: GridColumn<PartyBalanceRow>[] = [
  {
    key: 'name', header: 'Vendor',
    cell: (r) => (
      <span className="flex items-center gap-2">
        <span className="font-medium">{r.name}</span>
        {r.isMsme && <Badge variant="outline" className="text-[9px]">MSME</Badge>}
      </span>
    ),
    csv: (r) => r.name + (r.isMsme ? ' (MSME)' : ''),
  },
  { key: 'gstin', header: 'GSTIN', cell: (r) => <span className="font-mono text-xs">{r.gstin ?? '—'}</span>, csv: (r) => r.gstin ?? '' },
  { key: 'count', header: 'Bills', align: 'right', cell: (r) => <span className="tabular">{r.documentCount}</span>, csv: (r) => r.documentCount, total: (rs) => <span className="tabular">{rs.reduce((t, r) => t + r.documentCount, 0)}</span> },
  { key: 'billed', header: 'Billed', align: 'right', cell: (r) => <Money value={r.invoicedPaise} />, csv: (r) => toRupees(r.invoicedPaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.invoicedPaise, 0)} /> },
  { key: 'paid', header: 'Paid', align: 'right', cell: (r) => <Money value={r.receivedPaise} />, csv: (r) => toRupees(r.receivedPaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.receivedPaise, 0)} /> },
  {
    key: 'balance', header: 'Closing Balance', align: 'right',
    cell: (r) => <Money value={r.outstandingPaise} className={r.outstandingPaise > 0 ? 'font-medium' : 'text-muted-foreground'} />,
    csv: (r) => toRupees(r.outstandingPaise),
    total: (rs) => <Money value={rs.reduce((t, r) => t + r.outstandingPaise, 0)} />,
  },
];

export default function VendorBalancesPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<PartyBalancesReport>(
    () => reports.partyBalances('vendor', range.from, range.to),
    [range.from, range.to],
  );

  return (
    <ReportShell
      title="Vendor Balances"
      description="What each supplier has billed you, what you have paid, and what is still owed."
      range={range}
      onRangeChange={setRange}
      onExport={() => {
        if (state.data) downloadCsv('vendor-balances.csv', gridCsv(state.data.rows, columns));
      }}
    >
      <AsyncPage state={state}>
        {(d) => <ReportGrid rows={d.rows} columns={columns} emptyMessage="No vendor activity in this period." />}
      </AsyncPage>
    </ReportShell>
  );
}
