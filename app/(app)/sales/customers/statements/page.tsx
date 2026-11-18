'use client';

// Zoho's "Print Customer Statements" (components/contacts/bulk-statements.tsx).

import { BulkStatements } from '@/components/contacts/bulk-statements';

export default function CustomerStatementsPage() {
  return <BulkStatements side="customer" />;
}
