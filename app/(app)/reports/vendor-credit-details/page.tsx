'use client';

// Vendor Credit Details — every credit a supplier gave in the period, and what of it is unused.

import { SimpleReport } from '@/components/reports/simple-report';
import { dateCol, moneyCol, textCol } from '@/components/reports/cols';

interface Row { id: string; number: string; date: string; status: string; reason: string | null; vendorId: string; vendor: string; againstBill: string | null; totalPaise: number; appliedPaise: number; balancePaise: number }

export default function VendorCreditDetailsPage() {
  return (
    <SimpleReport<Row>
      report="vendor-credit-details" title="Vendor Credit Details"
      description="Credits from suppliers in the period: the bill each was against, how much has been used, and what is still to use."
      empty="No vendor credits in this period."
      columns={[
        dateCol('date', 'Date', (r) => r.date),
        textCol('number', 'Credit#', (r) => r.number, { strong: true }),
        textCol('vendor', 'Vendor', (r) => r.vendor, { href: (r) => `/purchases/vendors/${r.vendorId}` }),
        textCol('against', 'Against bill', (r) => r.againstBill, { muted: true }),
        textCol('reason', 'Reason', (r) => r.reason, { muted: true }),
        textCol('status', 'Status', (r) => r.status),
        moneyCol('total', 'Amount', (r) => r.totalPaise),
        moneyCol('applied', 'Used', (r) => r.appliedPaise),
        moneyCol('balance', 'Balance', (r) => r.balancePaise),
      ]}
    />
  );
}
