'use client';

// Where the money goes, read off the expense accounts in the journal.
//
// Reading the journal rather than the expenses table matters: a cost can reach
// an expense account from a bill, a standalone expense or a categorised bank
// line, and only the journal sees all three.

import { downloadCsv, ReportShell, useReportRange } from '@/components/shared/report-shell';
import { RankedReport, type RankedRow } from '@/components/shared/ranked-report';
import { AsyncPage } from '@/components/shared/async-state';
import { reports, type ExpensesByCategoryReport } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';

function toRanked(d: ExpensesByCategoryReport): RankedRow[] {
  return d.rows.map((r) => ({
    key: r.accountId,
    label: r.name,
    sublabel: `Account ${r.code} · ${r.count} posting${r.count === 1 ? '' : 's'}`,
    amountPaise: r.amountPaise,
  }));
}

export default function ExpensesByCategoryPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<ExpensesByCategoryReport>(
    () => reports.expensesByCategory(range.from, range.to),
    [range.from, range.to],
  );

  return (
    <ReportShell
      title="Expenses by Category"
      description="Where the money goes, taken straight from the expense accounts in your chart of accounts."
      range={range}
      onRangeChange={setRange}
      onExport={() => {
        if (!state.data) return;
        downloadCsv('expenses-by-category.csv', [
          ['Category', 'Detail', 'Amount'],
          ...toRanked(state.data).map((r) => [r.label, r.sublabel ?? '', toRupees(r.amountPaise)]),
        ]);
      }}
    >
      <AsyncPage state={state}>
        {(d) => <RankedReport rows={toRanked(d)} labelHeader="Category" valueHeader="Amount" />}
      </AsyncPage>
    </ReportShell>
  );
}
