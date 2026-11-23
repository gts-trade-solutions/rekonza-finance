'use client';

// Zoho Books' Edit on an invoice or debit note: the invoice form, filled with
// the document as saved, saved back over it (PUT /api/invoices/[id]).

import { Suspense } from 'react';
import { useParams } from 'next/navigation';
import { InvoiceForm } from '@/components/forms/invoice-form';
import { AsyncPage } from '@/components/shared/async-state';
import { invoices as invoiceApi, type InvoiceDetail } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

export default function EditInvoicePage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<InvoiceDetail>(() => invoiceApi.get(id), [id]);
  return (
    <AsyncPage state={state}>
      {(inv) => inv.status === 'void' ? (
        <p className="p-6 text-sm text-muted-foreground" data-slot="edit-void">{inv.number} is void, so it cannot be edited. Clone it to raise it again.</p>
      ) : (
        <Suspense>
          <InvoiceForm editing={inv} variant={inv.docKind === 'debit_note' ? 'debit_note' : 'invoice'} />
        </Suspense>
      )}
    </AsyncPage>
  );
}
