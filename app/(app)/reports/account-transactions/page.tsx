'use client';

// Every journal line in the period, across every account.
//
// This is the widest view of the books — the raw material behind every other
// report. Flattening entries into lines here rather than on the server keeps
// one journal endpoint serving both this and the entry-shaped journal report.

import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Money } from '@/components/shared/money';
import { downloadCsv, ReportShell, useReportRange } from '@/components/shared/report-shell';
import { ReportGrid, gridCsv, type GridColumn } from '@/components/shared/report-grid';
import { AsyncPage } from '@/components/shared/async-state';
import { journal, type JournalResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';

const SOURCE_ROUTE: Record<string, string> = {
  invoice: '/sales/invoices',
  bill: '/purchases/bills',
};

interface Row {
  key: string;
  entryNo: number;
  date: string;
  accountCode: string;
  accountName: string;
  memo: string;
  sourceType: string;
  sourceId: string | null;
  debit: number;
  credit: number;
}

function flatten(d: JournalResponse): Row[] {
  const out: Row[] = [];
  for (const e of d.entries) {
    for (const l of e.lines) {
      out.push({
        key: `${e.id}:${l.lineNo}`,
        entryNo: e.entryNo,
        date: e.date,
        accountCode: l.accountCode,
        accountName: l.accountName,
        memo: l.description ?? e.memo ?? '',
        sourceType: e.sourceType,
        sourceId: e.sourceId,
        debit: l.debitPaise,
        credit: l.creditPaise,
      });
    }
  }
  return out;
}

const columns: GridColumn<Row>[] = [
  { key: 'date', header: 'Date', cell: (r) => <span className="tabular text-xs">{new Date(r.date).toLocaleDateString('en-IN')}</span>, csv: (r) => r.date },
  { key: 'je', header: 'JE#', cell: (r) => <span className="tabular text-xs text-muted-foreground">#{r.entryNo}</span>, csv: (r) => r.entryNo },
  {
    key: 'account', header: 'Account',
    cell: (r) => (
      <span>
        <span className="tabular text-xs text-muted-foreground">{r.accountCode}</span>{' '}
        <span className="font-medium">{r.accountName}</span>
      </span>
    ),
    csv: (r) => `${r.accountCode} ${r.accountName}`,
  },
  { key: 'memo', header: 'Narration', cell: (r) => <span className="text-xs">{r.memo}</span>, csv: (r) => r.memo },
  {
    key: 'source', header: 'Source',
    cell: (r) =>
      r.sourceId && SOURCE_ROUTE[r.sourceType] ? (
        <Link href={`${SOURCE_ROUTE[r.sourceType]}/${r.sourceId}`} className="text-xs capitalize text-primary hover:underline">
          {r.sourceType.replace('_', ' ')} ↗
        </Link>
      ) : (
        <Badge variant="secondary" className="text-[9px] capitalize">{r.sourceType.replace('_', ' ')}</Badge>
      ),
    csv: (r) => r.sourceType,
  },
  { key: 'debit', header: 'Debit', align: 'right', cell: (r) => (r.debit ? <Money value={r.debit} /> : <span className="text-muted-foreground">—</span>), csv: (r) => toRupees(r.debit), total: (rs) => <Money value={rs.reduce((t, r) => t + r.debit, 0)} /> },
  { key: 'credit', header: 'Credit', align: 'right', cell: (r) => (r.credit ? <Money value={r.credit} /> : <span className="text-muted-foreground">—</span>), csv: (r) => toRupees(r.credit), total: (rs) => <Money value={rs.reduce((t, r) => t + r.credit, 0)} /> },
];

export default function AccountTransactionsPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<JournalResponse>(
    () => journal.list({ from: range.from, to: range.to, limit: 500 }),
    [range.from, range.to],
  );

  return (
    <ReportShell
      title="Account Transactions"
      description="Every journal line in the period, across every account. This is the widest view of the books — the raw material behind every other report."
      range={range}
      onRangeChange={setRange}
      onExport={() => {
        if (state.data) downloadCsv('account-transactions.csv', gridCsv(flatten(state.data), columns));
      }}
    >
      <AsyncPage state={state}>
        {(d) => <ReportGrid rows={flatten(d)} columns={columns} emptyMessage="No transactions in this period." />}
      </AsyncPage>
    </ReportShell>
  );
}
