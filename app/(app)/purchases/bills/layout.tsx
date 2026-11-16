'use client';

// Zoho's split view for this module: a record opens beside the list
// (components/shared/record-split.tsx). The list, the form and sub-pages pass through.

import { RecordSplit } from '@/components/shared/record-split';

export default function Layout({ children }: { children: React.ReactNode }) {
  return <RecordSplit kind="bill">{children}</RecordSplit>;
}
