'use client';

// Refund History — money actually returned, in both directions.
//
// A credit note is not a refund. A credit note reduces what a customer owes; a
// refund is cash leaving the bank. Most credits are applied against the next
// invoice and no money ever moves. This report reads the journal for the
// entries where it did — which is what an auditor asks for and what the bank
// statement will show.

import { Badge } from '@/components/ui/badge';
import { Money } from '@/components/shared/money';
import { downloadCsv, ReportShell, useReportRange } from '@/components/shared/report-shell';
import { ReportGrid, gridCsv, type GridColumn } from '@/components/shared/report-grid';
import { AsyncPage } from '@/components/shared/async-state';
import { reports, type RefundHistoryReport } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';
import { cn } from '@/lib/utils';

type Row = RefundHistoryReport['rows'][number];

const short = (d: string) => new Date(d).toLocaleDateString('en-IN');

const columns: GridColumn<Row>[] = [
  { key: 'date', header: 'Date', cell: (r) => <span className="tabular text-xs">{short(r.date)}</span>, csv: (r) => r.date },
  {
    key: 'direction', header: 'Direction',
    cell: (r) => (
      <Badge
        variant="outline"
        className={cn(
          'text-[10px]',
          r.direction === 'out'
            ? 'border-destructive/40 text-destructive'
            : 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
        )}
      >
        {r.direction === 'out' ? 'Refunded to customer' : 'Received from vendor'}
      </Badge>
    ),
    csv: (r) => (r.direction === 'out' ? 'Refunded to customer' : 'Received from vendor'),
  },
  { key: 'number', header: 'Credit#', cell: (r) => <span className="font-medium">{r.number}</span>, csv: (r) => r.number },
  { key: 'party', header: 'Party', cell: (r) => r.party, csv: (r) => r.party },
  { key: 'reason', header: 'Reason', cell: (r) => <span className="text-xs text-muted-foreground">{r.reason}</span>, csv: (r) => r.reason },
  { key: 'bank', header: 'Through', cell: (r) => <span className="text-xs">{r.bankName ?? '—'}</span>, csv: (r) => r.bankName ?? '' },
  {
    key: 'amount', header: 'Refunded', align: 'right',
    cell: (r) => <Money value={r.amountPaise} className="font-medium" />,
    csv: (r) => toRupees(r.amountPaise),
    total: (rs) => <Money value={rs.reduce((t, r) => t + r.amountPaise, 0)} />,
  },
];

export default function RefundHistoryPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<RefundHistoryReport>(
    () => reports.refundHistory(range.from, range.to),
    [range.from, range.to],
  );

  return (
    <ReportShell
      title="Refund History"
      description="Money genuinely returned, in either direction. A credit note that was set against the next invoice is not here — no cash moved."
      range={range}
      onRangeChange={setRange}
      onExport={() => {
        if (state.data) downloadCsv('refund-history.csv', gridCsv(state.data.rows, columns));
      }}
    >
      <AsyncPage state={state}>
        {(d) => (
          <ReportGrid
            rows={d.rows}
            columns={columns}
            emptyMessage="No refunds in this period — every credit was set against an invoice instead."
          />
        )}
      </AsyncPage>
    </ReportShell>
  );
}
