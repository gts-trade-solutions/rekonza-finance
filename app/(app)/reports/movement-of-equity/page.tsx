'use client';

// How the owners’ stake changed over the period.
//
// The point of the report is the split: money the owners put in or took out is
// not the same thing as profit the business earned, even though both land in
// equity. A business can grow its equity purely on injected capital while
// losing money, and this is where you would see that.

import { Money } from '@/components/shared/money';
import { downloadCsv, ReportShell, useReportRange } from '@/components/shared/report-shell';
import { ReportGrid, gridCsv, type GridColumn } from '@/components/shared/report-grid';
import { AsyncPage } from '@/components/shared/async-state';
import { reports, type MovementOfEquityReport } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';

type Row = MovementOfEquityReport['rows'][number];

const NOTE: Record<string, string> = {
  'Opening equity': 'Owners’ stake at the start of the period',
  'Capital introduced or withdrawn': 'Money the owners put in or took out',
  'Profit for the period': 'Earned by the business, not contributed by the owners',
  'Loss for the period': 'Absorbed by the business, reducing the owners’ stake',
  'Closing equity': 'Owners’ stake at the end of the period',
};

const columns: GridColumn<Row>[] = [
  {
    key: 'label', header: 'Particulars',
    cell: (r) => (
      <div>
        <p className={r.label.startsWith('Closing') || r.label.startsWith('Opening') ? 'font-semibold' : 'font-medium'}>
          {r.label}
        </p>
        <p className="text-xs text-muted-foreground">{NOTE[r.label] ?? ''}</p>
      </div>
    ),
    csv: (r) => r.label,
  },
  {
    key: 'amount', header: 'Amount', align: 'right',
    cell: (r) => (
      <Money
        value={r.amountPaise}
        colored={r.label.includes('for the period') || r.label.startsWith('Capital')}
        className={r.label.startsWith('Closing') ? 'text-base font-semibold' : undefined}
      />
    ),
    csv: (r) => toRupees(r.amountPaise),
  },
];

export default function MovementOfEquityPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<MovementOfEquityReport>(
    () => reports.movementOfEquity(range.from, range.to),
    [range.from, range.to],
  );

  return (
    <ReportShell
      title="Movement of Equity"
      description="How the owners’ stake changed over the period, separating money they put in from profit the business earned."
      range={range}
      onRangeChange={setRange}
      onExport={() => {
        if (state.data) downloadCsv('movement-of-equity.csv', gridCsv(state.data.rows, columns));
      }}
    >
      <AsyncPage state={state}>
        {(d) => <ReportGrid rows={d.rows} columns={columns} showTotals={false} />}
      </AsyncPage>
    </ReportShell>
  );
}
