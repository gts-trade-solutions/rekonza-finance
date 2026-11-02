'use client';

// Payable Details — every bill and vendor credit in the period, with what is still open on each.

import { SimpleReport } from '@/components/reports/simple-report';
import { dateCol, moneyCol, textCol } from '@/components/reports/cols';

interface Row { kind: string; id: string; number: string; date: string; dueDate: string | null; partyId: string; party: string; status: string; totalPaise: number; balancePaise: number }

export default function PayableDetailsPage() {
  return (
    <SimpleReport<Row>
      report="payable-details" title="Payable Details"
      description="Bills and vendor credits in the period, with each one's status and balance. Credits show as minus."
      empty="No bills or vendor credits in this period."
      columns={[
        dateCol('date', 'Date', (r) => r.date),
        textCol('kind', 'Type', (r) => r.kind, { muted: true }),
        textCol('number', 'Number', (r) => r.number, { strong: true, href: (r) => (r.kind === 'Bill' ? `/purchases/bills/${r.id}` : null) }),
        textCol('party', 'Vendor', (r) => r.party, { href: (r) => `/purchases/vendors/${r.partyId}` }),
        textCol('status', 'Status', (r) => r.status.replace(/_/g, ' ')),
        dateCol('due', 'Due', (r) => r.dueDate),
        moneyCol('total', 'Amount', (r) => r.totalPaise),
        moneyCol('balance', 'Balance', (r) => r.balancePaise),
      ]}
    />
  );
}
