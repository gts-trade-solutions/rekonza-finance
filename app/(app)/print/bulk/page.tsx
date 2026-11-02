'use client';

// Several documents printed in one go, each on its own page, as Zoho Books
// prints a selection from a list: invoices (the recipient's copy) or any other
// kind (lib/print-doc.ts). Reached from a list's selection: ?kind=…&ids=1,2,3.

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ArrowLeft, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AsyncPage } from '@/components/shared/async-state';
import { InvoiceSheetPrint } from '@/components/print/invoice-print';
import { DocumentSheet, LIST_PATH } from '@/components/print/document-print';
import { api, invoices as invoiceApi, type InvoiceDetail } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { printPage } from '@/lib/output-guard';
import { isPrintKind, type PrintDoc } from '@/lib/print-doc';

type Loaded = { kind: 'invoice'; docs: InvoiceDetail[] } | { kind: 'document'; docs: PrintDoc[] };

function Bulk() {
  const params = useSearchParams();
  const kind = params.get('kind') ?? '';
  const ids = (params.get('ids') ?? '').split(',').filter((x) => /^\d+$/.test(x)).slice(0, 100);
  const state = useApi<Loaded>(async () => {
    // Nothing chosen yet: nothing to fetch, and nothing wrong.
    if (!ids.length) return { kind: 'document', docs: [] };
    // One after another: a hundred requests at once would only queue at the server.
    if (kind === 'invoice') {
      const docs: InvoiceDetail[] = [];
      for (const id of ids) docs.push(await invoiceApi.get(id));
      return { kind: 'invoice', docs };
    }
    if (!isPrintKind(kind)) throw new Error('There is no such document to print.');
    const docs: PrintDoc[] = [];
    for (const id of ids) docs.push(await api.get<PrintDoc>(`/api/print/${kind}/${id}`));
    return { kind: 'document', docs };
  }, [kind, ids.join(',')]);
  const back = kind === 'invoice' ? '/sales/invoices' : isPrintKind(kind) ? LIST_PATH[kind] : '/dashboard';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 no-print">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" asChild><Link href={back}><ArrowLeft className="size-3.5" /> Back</Link></Button>
          <h1 className="text-sm font-semibold">Print selected documents</h1>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground" data-slot="bulk-count">
            {ids.length ? `${ids.length} document${ids.length === 1 ? '' : 's'}, one to a page` : 'Select documents on a list, then Print'}
          </span>
          <Button size="sm" onClick={() => printPage(`${ids.length} ${kind} documents`)} data-slot="print-all" disabled={!state.data}>
            <Printer className="size-3.5" /> Print or save as PDF
          </Button>
        </div>
      </div>
      <AsyncPage state={state}>
        {(d) => d.kind === 'invoice'
          ? <>{d.docs.map((inv, i) => <InvoiceSheetPrint key={inv.id} inv={inv} last={i === d.docs.length - 1} />)}</>
          : <>{d.docs.map((doc, i) => <DocumentSheet key={doc.id} doc={doc} copyLabel={doc.copies.length > 1 ? doc.copies[0] : null} last={i === d.docs.length - 1} />)}</>}
      </AsyncPage>
    </div>
  );
}

export default function BulkPrintPage() {
  return <Suspense><Bulk /></Suspense>;
}
