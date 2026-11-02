'use client';

// Expenses by Project — what each project has cost in spending, billable or not.

import { SimpleReport } from '@/components/reports/simple-report';
import { moneyCol, numCol, textCol } from '@/components/reports/cols';

interface Row { id: string | null; name: string; count: number; amountPaise: number; taxPaise: number; billablePaise: number; billedPaise: number }

export default function ExpensesByProjectPage() {
  return (
    <SimpleReport<Row>
      report="expenses-by-project" title="Expenses by Project"
      description="Expenses recorded against each project in the period, what was billable, and what has been charged on."
      empty="No expenses in this period."
      columns={[
        textCol('name', 'Project', (r) => r.name, { strong: true, href: (r) => (r.id ? `/projects/${r.id}` : null) }),
        numCol('count', 'Expenses', (r) => r.count, { digits: 0, total: true }),
        moneyCol('amount', 'Amount', (r) => r.amountPaise),
        moneyCol('tax', 'Tax', (r) => r.taxPaise),
        moneyCol('billable', 'Billable', (r) => r.billablePaise),
        moneyCol('billed', 'Billed', (r) => r.billedPaise),
      ]}
    />
  );
}
