'use client';

// Import from QuickBooks: Desktop's IIF files, and Online's lists and Journal report.

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/page-header';
import { QuickBooksImport } from '@/components/quickbooks/file-import';

export default function QuickBooksImportPage() {
  return (
    <>
      <PageHeader
        title="Import from QuickBooks"
        description="Bring a company across from QuickBooks Online or Desktop: the chart of accounts, customers, vendors, products and services, and the transactions. Checked before anything is saved."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/settings/import"><ArrowLeft className="mr-1.5 size-3.5" /> All imports</Link>
          </Button>
        }
      />
      <QuickBooksImport />
    </>
  );
}
