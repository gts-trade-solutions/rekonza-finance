'use client';

// Billable Expense Details — expenses to charge on to a customer: billed, or still to bill.

import { SimpleReport } from '@/components/reports/simple-report';
import { dateCol, moneyCol, textCol } from '@/components/reports/cols';

interface Row { id: string; number: string | null; date: string; account: string; customer: string | null; customerId: string | null; project: string | null; totalPaise: number; invoice: string | null; invoiceId: string | null; notes: string | null }

export default function BillableExpenseDetailsPage() {
  return (
    <SimpleReport<Row>
      report="billable-expense-details" title="Billable Expense Details"
      description="Every expense marked billable in the period, the customer it is for, and the invoice it went on — or blank, still to bill."
      empty="No billable expenses in this period."
      columns={[
        dateCol('date', 'Date', (r) => r.date),
        textCol('number', 'Expense#', (r) => r.number, { strong: true }),
        textCol('account', 'Account', (r) => r.account),
        textCol('customer', 'Customer', (r) => r.customer, { href: (r) => (r.customerId ? `/sales/customers/${r.customerId}` : null) }),
        textCol('project', 'Project', (r) => r.project, { muted: true }),
        textCol('invoice', 'Billed on', (r) => r.invoice ?? 'Not yet billed', { href: (r) => (r.invoiceId ? `/sales/invoices/${r.invoiceId}` : null) }),
        moneyCol('total', 'Amount', (r) => r.totalPaise),
      ]}
    />
  );
}
