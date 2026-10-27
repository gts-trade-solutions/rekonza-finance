'use client';

// Purchase orders with something left to receive or bill.

import { PendingOrdersReport } from '@/components/shared/pending-orders';

export default function PendingPurchaseOrdersPage() {
  return <PendingOrdersReport kind="purchase" />;
}
