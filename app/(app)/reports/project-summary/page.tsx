'use client';

// Project Summary — each project's hours, what it has been invoiced, what it has cost, and the margin.

import { SimpleReport } from '@/components/reports/simple-report';
import { moneyCol, numCol, textCol } from '@/components/reports/cols';

interface Row { id: string; name: string; status: string; billingMethod: string; customer: string | null; hours: number; billableHours: number; billedHours: number; invoicedPaise: number; expensesPaise: number; marginPaise: number; budgetPaise: number | null }

export default function ProjectSummaryPage() {
  return (
    <SimpleReport<Row>
      report="project-summary" title="Project Summary"
      description="Every project: hours logged, billable and billed in the period; what it was invoiced and spent on it; and what that leaves."
      empty="No projects yet."
      columns={[
        textCol('name', 'Project', (r) => r.name, { strong: true, href: (r) => `/projects/${r.id}` }),
        textCol('customer', 'Customer', (r) => r.customer),
        textCol('status', 'Status', (r) => r.status.replace(/_/g, ' ')),
        textCol('method', 'Billing', (r) => r.billingMethod.replace(/_/g, ' '), { muted: true }),
        numCol('hours', 'Hours', (r) => r.hours, { total: true }),
        numCol('billable', 'Billable hrs', (r) => r.billableHours, { total: true }),
        numCol('billed', 'Billed hrs', (r) => r.billedHours, { total: true }),
        moneyCol('invoiced', 'Invoiced', (r) => r.invoicedPaise),
        moneyCol('expenses', 'Expenses', (r) => r.expensesPaise),
        moneyCol('margin', 'Margin', (r) => r.marginPaise, { colored: true }),
      ]}
    />
  );
}
