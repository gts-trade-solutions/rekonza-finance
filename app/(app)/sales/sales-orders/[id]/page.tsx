'use client';

// One record beside the list, as Zoho shows it (components/sales/sales-doc-record.tsx).

import { SalesDocRecordView } from '@/components/sales/sales-doc-record';

export default function Page() {
  return <SalesDocRecordView kind="sales-order" />;
}
