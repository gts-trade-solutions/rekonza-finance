'use client';

// Record Bulk Payments: many bills, of one vendor or several, paid at once (components/payments/bulk-payments.tsx).

import { BulkPayments } from '@/components/payments/bulk-payments';

export default function Page() {
  return <BulkPayments side="made" />;
}
