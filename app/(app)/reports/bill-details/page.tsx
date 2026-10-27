'use client';

// Every supplier bill in the period, with the TDS withheld on it.

import { Money } from '@/components/shared/money';
import { Badge } from '@/components/ui/badge';
import { downloadCsv, ReportShell, useReportRange } from '@/components/shared/report-shell';
import { ReportGrid, gridCsv, type GridColumn } from '@/components/shared/report-grid';
import { AsyncPage } from '@/components/shared/async-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { bills, type BillListItem, type BillListResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';

const short = (d: string) => new Date(d).toLocaleDateString('en-IN');

const columns: GridColumn<BillListItem>[] = [
  { key: 'date', header: 'Date', cell: (r) => <span className="tabular text-xs">{short(r.date)}</span>, csv: (r) => r.date },
  { key: 'number', header: 'Bill#', cell: (r) => <span className="font-medium">{r.internalNo}</span>, csv: (r) => r.internalNo },
  { key: 'vendorRef', header: 'Vendor Invoice#', cell: (r) => <span className="text-xs text-muted-foreground">{r.vendorInvoiceNo}</span>, csv: (r) => r.vendorInvoiceNo },
  {
    key: 'vendor', header: 'Vendor',
    cell: (r) => (
      <span className="flex items-center gap-2">
        {r.vendorName}
        {r.isMsme && <Badge variant="outline" className="text-[9px]">MSME</Badge>}
        {r.isRcm && <Badge variant="outline" className="text-[9px]">RCM</Badge>}
      </span>
    ),
    csv: (r) => r.vendorName,
  },
  { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} />, csv: (r) => r.status },
  {
    key: 'tds', header: 'TDS', align: 'right',
    cell: (r) => (
      <span>
        <Money value={r.tdsPaise} showZero={false} />
        {r.tdsSection && <span className="ml-1 text-[10px] text-muted-foreground">{r.tdsSection}</span>}
      </span>
    ),
    csv: (r) => toRupees(r.tdsPaise),
    total: (rs) => <Money value={rs.reduce((t, r) => t + r.tdsPaise, 0)} />,
  },
  { key: 'total', header: 'Payable', align: 'right', cell: (r) => <Money value={r.totalPaise} />, csv: (r) => toRupees(r.totalPaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.totalPaise, 0)} /> },
  { key: 'balance', header: 'Balance Due', align: 'right', cell: (r) => <Money value={r.balancePaise} showZero={false} />, csv: (r) => toRupees(r.balancePaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.balancePaise, 0)} /> },
];

export default function BillDetailsPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<BillListResponse>(
    () => bills.list({ from: range.from, to: range.to, limit: 500 }),
    [range.from, range.to],
  );

  return (
    <ReportShell
      title="Bill Details"
      description="Every supplier bill in the period, with TDS withheld and what is still owed."
      range={range}
      onRangeChange={setRange}
      onExport={() => {
        if (state.data) downloadCsv('bill-details.csv', gridCsv(state.data.bills, columns));
      }}
    >
      <AsyncPage state={state}>
        {(d) => <ReportGrid rows={d.bills} columns={columns} emptyMessage="No bills in this period." />}
      </AsyncPage>
    </ReportShell>
  );
}
