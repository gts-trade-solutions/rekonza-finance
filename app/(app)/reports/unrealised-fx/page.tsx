'use client';

// Unrealised Gain or Loss — what open foreign-currency invoices and bills
// would gain or lose if restated at the date's closing rates.

import { SimpleReport } from '@/components/reports/simple-report';
import { moneyCol, numCol, textCol } from '@/components/reports/cols';

interface Row {
  kind: 'invoice' | 'bill'; id: string; number: string; contactId: string; party: string; currency: string;
  foreignOpenPaise: number; bookedRate: number; carriedPaise: number; closingRate: number | null; restatedPaise: number | null; differencePaise: number | null;
}

export default function UnrealisedFxPage() {
  return (
    <SimpleReport<Row>
      report="unrealised-fx" title="Unrealised Exchange Gain or Loss" asOf
      description="Open foreign-currency documents at the date: carried at the booked rate, and at the closing rate. Enter closing rates under Accountant → Foreign Currency, and restate there at a period end."
      empty="No open foreign-currency invoices or bills at this date."
      columns={[
        textCol('number', 'Document', (r) => `${r.kind === 'invoice' ? 'Invoice' : 'Bill'} ${r.number}`, { strong: true, href: (r) => (r.kind === 'invoice' ? `/sales/invoices/${r.id}` : `/purchases/bills/${r.id}`) }),
        textCol('party', 'Party', (r) => r.party),
        textCol('currency', 'Currency', (r) => r.currency),
        numCol('open', 'Open (foreign)', (r) => r.foreignOpenPaise / 100),
        numCol('booked', 'Booked rate', (r) => r.bookedRate, { digits: 4 }),
        textCol('closing', 'Closing rate', (r) => (r.closingRate === null ? 'Not entered' : String(r.closingRate))),
        moneyCol('carried', 'Carried', (r) => r.carriedPaise),
        moneyCol('restated', 'At closing rate', (r) => r.restatedPaise),
        // A receivable worth more is a gain; a payable worth more is a loss.
        moneyCol('difference', 'Gain / (loss)', (r) => (r.differencePaise === null ? null : r.kind === 'invoice' ? r.differencePaise : -r.differencePaise), { colored: true }),
      ]}
    />
  );
}
