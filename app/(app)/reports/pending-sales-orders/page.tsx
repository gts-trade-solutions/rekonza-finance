'use client';

// Sales orders with something left to deliver or invoice.

import { PendingOrdersReport } from '@/components/shared/pending-orders';

export default function PendingSalesOrdersPage() {
  return <PendingOrdersReport kind="sales" />;
}
