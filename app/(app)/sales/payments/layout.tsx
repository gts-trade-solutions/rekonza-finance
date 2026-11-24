'use client';

// Zoho's split view for payments received: a payment opens beside the list
// (components/shared/record-split.tsx). The list and the form pass through.

import { RecordSplit } from '@/components/shared/record-split';

export default function Layout({ children }: { children: React.ReactNode }) {
  return <RecordSplit kind="payment-received">{children}</RecordSplit>;
}
