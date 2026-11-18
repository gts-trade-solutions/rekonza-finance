'use client';

// Zoho's "Print Customer Statements": the statements of the customers ticked
// in the list, one after another, each on its own page, to print or save as
// one PDF. ?ids=1,2,3 and the statement's own ?from= and ?to=.

import Link from 'next/link';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AsyncPage } from '@/components/shared/async-state';
import { StatementPrint } from '@/components/print/statement-print';
import { statementPeriod } from '@/components/shared/party-statement';
import { contacts, type PartyStatement } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { printPage } from '@/lib/output-guard';

function Statements() {
  const params = useSearchParams();
  const ids = (params.get('ids') ?? '').split(',').filter((x) => /^\d+$/.test(x)).slice(0, 50);
  const { from, to } = statementPeriod(params);
  const state = useApi<PartyStatement[]>(() => Promise.all(ids.map((id) => contacts.statement(id, { side: 'customer', from, to }))), [ids.join(','), from, to]);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 no-print">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" asChild>
            <Link href="/sales/customers"><ArrowLeft className="size-3.5" /> Customers</Link>
          </Button>
          <h1 className="text-[18px] font-semibold">Customer Statements</h1>
        </div>
        {ids.length > 0 && (
          <Button size="sm" onClick={() => printPage()} data-slot="print-statements">
            <Printer className="size-3.5" /> Print or save {ids.length} statement{ids.length === 1 ? '' : 's'} as PDF
          </Button>
        )}
      </div>
      {!ids.length ? (
        <p className="rounded-[var(--radius-card)] border px-5 py-10 text-center text-[13px] text-muted-foreground no-print" data-slot="statements-none">
          Tick the customers in the list, then choose Print Customer Statements.
        </p>
      ) : (
      <AsyncPage state={state}>
        {(all) => <div className="space-y-6" data-slot="bulk-statements">{all.map((s) => <StatementPrint key={s.party.id} s={s} backHref="/sales/customers" bare />)}</div>}
      </AsyncPage>
      )}
    </div>
  );
}

export default function CustomerStatementsPage() {
  return <Suspense><Statements /></Suspense>;
}
