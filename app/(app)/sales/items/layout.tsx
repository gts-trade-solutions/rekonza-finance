'use client';

// Zoho's split view for items: an item opens beside the list
// (components/shared/record-split.tsx). The list, the form and the edit page pass through.

import { RecordSplit } from '@/components/shared/record-split';

export default function Layout({ children }: { children: React.ReactNode }) {
  return <RecordSplit kind="item">{children}</RecordSplit>;
}
