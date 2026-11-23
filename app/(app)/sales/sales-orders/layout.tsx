'use client';

// Zoho's split view: a record opens beside the list (components/shared/record-split.tsx).
// The list, the New and Edit forms pass through.

import { RecordSplit } from '@/components/shared/record-split';

export default function Layout({ children }: { children: React.ReactNode }) {
  return <RecordSplit kind="sales-order">{children}</RecordSplit>;
}
