'use client';

// Expenses by Customer — spending incurred for each customer, billable or not.

import { SimpleReport } from '@/components/reports/simple-report';
import { moneyCol, numCol, textCol } from '@/components/reports/cols';

interface Row { id: string | null; name: string; count: number; amountPaise: number; taxPaise: number; billablePaise: number; billedPaise: number }

export default function ExpensesByCustomerPage() {
  return (
    <SimpleReport<Row>
      report="expenses-by-customer" title="Expenses by Customer"
      description="Expenses recorded against each customer in the period, what was billable, and what has been charged on."
      empty="No expenses in this period."
      columns={[
        textCol('name', 'Customer', (r) => r.name, { strong: true, href: (r) => (r.id ? `/sales/customers/${r.id}` : null) }),
        numCol('count', 'Expenses', (r) => r.count, { digits: 0, total: true }),
        moneyCol('amount', 'Amount', (r) => r.amountPaise),
        moneyCol('tax', 'Tax', (r) => r.taxPaise),
        moneyCol('billable', 'Billable', (r) => r.billablePaise),
        moneyCol('billed', 'Billed', (r) => r.billedPaise),
      ]}
    />
  );
}
