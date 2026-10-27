'use client';

// Every expense in the period, with the input credit claimed on it.

import { Money } from '@/components/shared/money';
import { Badge } from '@/components/ui/badge';
import { downloadCsv, ReportShell, useReportRange } from '@/components/shared/report-shell';
import { ReportGrid, gridCsv, type GridColumn } from '@/components/shared/report-grid';
import { AsyncPage } from '@/components/shared/async-state';
import { expenses, type ExpenseListItem } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';

interface Response { expenses: ExpenseListItem[]; summary: { count: number; totalPaise: number } }

const short = (d: string) => new Date(d).toLocaleDateString('en-IN');

const columns: GridColumn<ExpenseListItem>[] = [
  { key: 'date', header: 'Date', cell: (r) => <span className="tabular text-xs">{short(r.date)}</span>, csv: (r) => r.date },
  { key: 'number', header: 'Expense#', cell: (r) => <span className="font-medium">{r.number}</span>, csv: (r) => r.number },
  { key: 'account', header: 'Category', cell: (r) => r.accountName, csv: (r) => r.accountName },
  { key: 'vendor', header: 'Vendor', cell: (r) => r.vendorName ?? '—', csv: (r) => r.vendorName ?? '' },
  { key: 'notes', header: 'Description', cell: (r) => <span className="text-xs text-muted-foreground">{r.notes ?? ''}</span>, csv: (r) => r.notes ?? '' },
  {
    key: 'billable', header: 'Billable', align: 'center',
    cell: (r) => (r.isBillable ? <Badge variant="outline" className="text-[9px]">Billable</Badge> : <span className="text-xs text-muted-foreground">—</span>),
    csv: (r) => (r.isBillable ? 'Yes' : 'No'),
  },
  {
    key: 'itc', header: 'Input Credit', align: 'right',
    // Tax on a blocked expense is not a credit you can claim, so it is not
    // shown as one. Section 17(5) blocks it outright.
    cell: (r) => (
      r.itcEligibility === 'ineligible'
        ? <span className="text-xs text-muted-foreground">Blocked</span>
        : <Money value={r.taxPaise} showZero={false} />
    ),
    csv: (r) => (r.itcEligibility === 'ineligible' ? '0.00' : toRupees(r.taxPaise)),
    total: (rs) => <Money value={rs.reduce((t, r) => t + (r.itcEligibility === 'ineligible' ? 0 : r.taxPaise), 0)} />,
  },
  { key: 'amount', header: 'Amount', align: 'right', cell: (r) => <Money value={r.totalPaise} className="font-medium" />, csv: (r) => toRupees(r.totalPaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.totalPaise, 0)} /> },
];

export default function ExpenseDetailsPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<Response>(
    () => expenses.list({ from: range.from, to: range.to, limit: 500 }),
    [range.from, range.to],
  );

  return (
    <ReportShell
      title="Expense Details"
      description="Every expense in the period, with the input credit claimed on it."
      range={range}
      onRangeChange={setRange}
      onExport={() => {
        if (state.data) downloadCsv('expense-details.csv', gridCsv(state.data.expenses, columns));
      }}
    >
      <AsyncPage state={state}>
        {(d) => <ReportGrid rows={d.expenses} columns={columns} emptyMessage="No expenses in this period." />}
      </AsyncPage>
    </ReportShell>
  );
}
