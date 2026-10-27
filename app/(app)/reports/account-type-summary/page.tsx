'use client';

// The five account families at a glance.
//
// Balances are shown in each family’s natural direction — assets and expenses
// grow with debits, everything else with credits — so nothing reads negative
// merely because of which side of the ledger it lives on.

import { Money } from '@/components/shared/money';
import { downloadCsv, ReportShell, useReportRange } from '@/components/shared/report-shell';
import { ReportGrid, gridCsv, type GridColumn } from '@/components/shared/report-grid';
import { AsyncPage } from '@/components/shared/async-state';
import { reports, type AccountTypeSummaryReport } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';

type Row = AccountTypeSummaryReport['rows'][number];

const LABEL: Record<string, string> = {
  asset: 'Assets',
  liability: 'Liabilities',
  equity: 'Equity',
  income: 'Income',
  expense: 'Expenses',
};

const columns: GridColumn<Row>[] = [
  { key: 'label', header: 'Account Type', cell: (r) => <span className="font-medium">{LABEL[r.type] ?? r.type}</span>, csv: (r) => LABEL[r.type] ?? r.type },
  {
    key: 'accounts', header: 'Accounts Used', align: 'right',
    cell: (r) => (
      <span className="tabular">
        {r.accounts}
        <span className="text-muted-foreground"> / {r.totalAccounts}</span>
      </span>
    ),
    csv: (r) => `${r.accounts} of ${r.totalAccounts}`,
    total: (rs) => <span className="tabular">{rs.reduce((t, r) => t + r.accounts, 0)}</span>,
  },
  { key: 'debit', header: 'Total Debit', align: 'right', cell: (r) => <Money value={r.debitPaise} showZero={false} />, csv: (r) => toRupees(r.debitPaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.debitPaise, 0)} /> },
  { key: 'credit', header: 'Total Credit', align: 'right', cell: (r) => <Money value={r.creditPaise} showZero={false} />, csv: (r) => toRupees(r.creditPaise), total: (rs) => <Money value={rs.reduce((t, r) => t + r.creditPaise, 0)} /> },
  { key: 'net', header: 'Closing Balance', align: 'right', cell: (r) => <Money value={r.netPaise} className="font-medium" />, csv: (r) => toRupees(r.netPaise) },
];

export default function AccountTypeSummaryPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<AccountTypeSummaryReport>(
    () => reports.accountTypeSummary(range.from, range.to),
    [range.from, range.to],
  );

  return (
    <ReportShell
      title="Account Type Summary"
      description="The five account families at a glance. Balances are shown in each family’s natural direction, so nothing looks negative merely because it is credit-normal."
      range={range}
      onRangeChange={setRange}
      asOfOnly
      onExport={() => {
        if (state.data) downloadCsv('account-type-summary.csv', gridCsv(state.data.rows, columns));
      }}
    >
      <AsyncPage state={state}>
        {(d) => <ReportGrid rows={d.rows} columns={columns} emptyMessage="No account activity yet." />}
      </AsyncPage>
    </ReportShell>
  );
}
