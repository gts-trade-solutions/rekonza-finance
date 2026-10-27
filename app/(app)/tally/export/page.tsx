'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Export to Tally: this book's own documents, written as Tally vouchers.
//
// The opposite direction to /tally, which reads a TallyPrime company in. This
// is for the business that bills here while its accountant keeps the statutory
// books in Tally — the invoices, bills, payments and journals go across as
// vouchers, with the parties and their bill references intact.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { MonitorDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/page-header';
import { ExportPanel } from '@/components/tally/export-panel';

export default function TallyExportPage() {
  return (
    <>
      <PageHeader
        title="Export to Tally"
        description="Everything posted here, as TallyPrime vouchers your accountant imports. Nothing is changed in this book, and importing the same period twice does not enter it twice."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/tally">
              <MonitorDown className="size-3.5" /> Tally books
            </Link>
          </Button>
        }
      />
      <ExportPanel />
    </>
  );
}
