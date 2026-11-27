'use client';

// Record Bulk Receipts: many invoices, of one customer or several, paid at once (components/payments/bulk-payments.tsx).

import { BulkPayments } from '@/components/payments/bulk-payments';

export default function Page() {
  return <BulkPayments side="received" />;
}
