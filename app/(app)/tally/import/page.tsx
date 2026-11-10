'use client';

// Import from Tally: the XML files TallyPrime exports — masters, vouchers, or
// both — read here, checked, then brought into these books.

import Link from 'next/link';
import { MonitorDown, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/page-header';
import { TallyFileImport } from '@/components/tally/file-import';

export default function TallyImportPage() {
  return (
    <>
      <PageHeader
        title="Import from Tally"
        description="Bring a company across from its Tally files: ledgers, groups and stock items with their opening balances, then the vouchers. Nothing is saved until the check passes and you bring it in."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link href="/tally/export"><Upload className="size-3.5" /> Export to Tally</Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href="/tally"><MonitorDown className="size-3.5" /> Tally</Link>
            </Button>
          </div>
        }
      />
      <TallyFileImport />
    </>
  );
}
