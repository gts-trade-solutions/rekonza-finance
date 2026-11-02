'use client';

// Reconciliation Status — each bank account's statement lines matched and
// not, and the book balance beside the statement's at the date.

import { SimpleReport } from '@/components/reports/simple-report';
import { dateCol, moneyCol, numCol, textCol } from '@/components/reports/cols';

interface Row {
  id: string; name: string; kind: string; lines: number; matched: number; unmatched: number; unmatchedInPaise: number; unmatchedOutPaise: number;
  lastLine: string | null; lastReconciledAt: string | null; bookBalancePaise: number; statementBalancePaise: number | null; differencePaise: number | null;
}

export default function ReconciliationStatusPage() {
  return (
    <SimpleReport<Row>
      report="reconciliation-status" title="Reconciliation Status" asOf
      description="For each bank and cash account at the date: statement lines matched and still to match, and the books' balance against the statement's."
      empty="No bank accounts yet."
      columns={[
        textCol('name', 'Account', (r) => r.name, { strong: true, href: () => '/banking' }),
        numCol('lines', 'Statement lines', (r) => r.lines, { digits: 0, total: true }),
        numCol('matched', 'Matched', (r) => r.matched, { digits: 0, total: true }),
        numCol('unmatched', 'To match', (r) => r.unmatched, { digits: 0, total: true }),
        moneyCol('in', 'Unmatched in', (r) => r.unmatchedInPaise),
        moneyCol('out', 'Unmatched out', (r) => r.unmatchedOutPaise),
        dateCol('last', 'Last line', (r) => r.lastLine),
        moneyCol('book', 'Book balance', (r) => r.bookBalancePaise),
        moneyCol('statement', 'Statement balance', (r) => r.statementBalancePaise),
        moneyCol('difference', 'Difference', (r) => r.differencePaise, { total: false }),
      ]}
    />
  );
}
