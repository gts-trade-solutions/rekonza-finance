'use client';

// Payments Received — every customer receipt in the period.

import { Money } from '@/components/shared/money';
import { Badge } from '@/components/ui/badge';
import { downloadCsv, ReportShell, useReportRange } from '@/components/shared/report-shell';
import { ReportGrid, gridCsv, type GridColumn } from '@/components/shared/report-grid';
import { AsyncPage } from '@/components/shared/async-state';
import { payments, type PaymentListItem, type PaymentListResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';

const short = (d: string) => new Date(d).toLocaleDateString('en-IN');

const columns: GridColumn<PaymentListItem>[] = [
  { key: 'date', header: 'Date', cell: (r) => <span className="tabular text-xs">{short(r.date)}</span>, csv: (r) => r.date },
  { key: 'number', header: 'Payment#', cell: (r) => <span className="font-medium">{r.number}</span>, csv: (r) => r.number },
  { key: 'party', header: 'Customer', cell: (r) => r.contactName, csv: (r) => r.contactName },
  { key: 'mode', header: 'Mode', cell: (r) => <Badge variant="secondary" className="uppercase text-[10px]">{r.mode}</Badge>, csv: (r) => r.mode },
  { key: 'account', header: 'Deposited To', cell: (r) => <span className="text-xs">{r.bankName}</span>, csv: (r) => r.bankName },
  { key: 'ref', header: 'Reference', cell: (r) => <span className="text-xs text-muted-foreground">{r.reference || '—'}</span>, csv: (r) => r.reference ?? '' },
  { key: 'tds', header: 'TDS Withheld', align: 'right', cell: (r) => <Money value={r.tdsPaise} showZero={false} />, csv: (r) => toRupees(r.tdsPaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.tdsPaise, 0)} /> },
  { key: 'unapplied', header: 'On Account', align: 'right', cell: (r) => <Money value={r.unappliedPaise} showZero={false} />, csv: (r) => toRupees(r.unappliedPaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.unappliedPaise, 0)} /> },
  { key: 'docs', header: 'Invoices', align: 'center', cell: (r) => <span className="tabular text-xs">{r.allocationCount}</span>, csv: (r) => r.allocationCount },
  { key: 'amount', header: 'Amount', align: 'right', cell: (r) => <Money value={r.amountPaise} className="font-medium" />, csv: (r) => toRupees(r.amountPaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.amountPaise, 0)} /> },
];

export default function PaymentsReceivedReportPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<PaymentListResponse>(
    () => payments.list({ kind: 'received', from: range.from, to: range.to, limit: 500 }),
    [range.from, range.to],
  );

  return (
    <ReportShell
      title="Payments Received"
      description="Every customer receipt in the period, including tax they withheld and any amount still sitting on account."
      range={range}
      onRangeChange={setRange}
      onExport={() => {
        if (state.data) downloadCsv('payments-received.csv', gridCsv(state.data.payments, columns));
      }}
    >
      <AsyncPage state={state}>
        {(d) => <ReportGrid rows={d.payments} columns={columns} emptyMessage="No receipts in this period." />}
      </AsyncPage>
    </ReportShell>
  );
}
