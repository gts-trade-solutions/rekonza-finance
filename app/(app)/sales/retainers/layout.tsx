'use client';

// Zoho's split view for service (retainer) invoices: one opens beside the list
// (components/shared/record-split.tsx). The list and the forms pass through.

import { RecordSplit } from '@/components/shared/record-split';

export default function Layout({ children }: { children: React.ReactNode }) {
  return <RecordSplit kind="retainer">{children}</RecordSplit>;
}
