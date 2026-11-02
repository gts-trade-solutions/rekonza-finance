'use client';

// Purchase Order Details — every order in the period, with what has arrived and been billed.

import { SimpleReport } from '@/components/reports/simple-report';
import { dateCol, moneyCol, numCol, textCol } from '@/components/reports/cols';

interface Row {
  id: string; number: string; date: string; expected: string | null; status: string; vendorId: string; vendor: string;
  totalPaise: number; billedPaise: number; orderedQty: number; receivedQty: number; billedQty: number; vendorResponse: string | null;
}

export default function PurchaseOrderDetailsPage() {
  return (
    <SimpleReport<Row>
      report="purchase-order-details" title="Purchase Order Details"
      description="Every purchase order raised in the period: received and billed so far, and the vendor's answer from the portal."
      empty="No purchase orders in this period."
      columns={[
        dateCol('date', 'Date', (r) => r.date),
        textCol('number', 'PO#', (r) => r.number, { strong: true }),
        textCol('vendor', 'Vendor', (r) => r.vendor, { href: (r) => `/purchases/vendors/${r.vendorId}` }),
        textCol('status', 'Status', (r) => r.status.replace(/_/g, ' ')),
        textCol('response', 'Vendor answer', (r) => r.vendorResponse, { muted: true }),
        dateCol('expected', 'Expected', (r) => r.expected),
        numCol('ordered', 'Qty ordered', (r) => r.orderedQty, { digits: 3 }),
        numCol('received', 'Qty received', (r) => r.receivedQty, { digits: 3 }),
        moneyCol('billed', 'Billed', (r) => r.billedPaise),
        moneyCol('total', 'Amount', (r) => r.totalPaise),
      ]}
    />
  );
}
