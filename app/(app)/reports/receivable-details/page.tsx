'use client';

// Receivable Details — every document that adds to or takes from what customers owe:
// invoices and debit notes, credit notes, retainers, with what is still open on each.

import { SimpleReport } from '@/components/reports/simple-report';
import { dateCol, moneyCol, textCol } from '@/components/reports/cols';

interface Row { kind: string; id: string; number: string; date: string; dueDate: string | null; partyId: string; party: string; status: string; totalPaise: number; balancePaise: number }

const href = (r: Row) => (r.kind === 'Invoice' || r.kind === 'Debit note' ? `/sales/invoices/${r.id}` : null);

export default function ReceivableDetailsPage() {
  return (
    <SimpleReport<Row>
      report="receivable-details" title="Receivable Details"
      description="Invoices, debit notes, credit notes and retainers raised in the period, with each one's status and balance. Credits show as minus."
      empty="No receivables raised in this period."
      columns={[
        dateCol('date', 'Date', (r) => r.date),
        textCol('kind', 'Type', (r) => r.kind, { muted: true }),
        textCol('number', 'Number', (r) => r.number, { strong: true, href }),
        textCol('party', 'Customer', (r) => r.party, { href: (r) => `/sales/customers/${r.partyId}` }),
        textCol('status', 'Status', (r) => r.status.replace(/_/g, ' ')),
        dateCol('due', 'Due', (r) => r.dueDate),
        moneyCol('total', 'Amount', (r) => r.totalPaise),
        moneyCol('balance', 'Balance', (r) => r.balancePaise),
      ]}
    />
  );
}
