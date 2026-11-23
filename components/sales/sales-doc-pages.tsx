'use client';

// The New and Edit pages of a quote, sales order, delivery challan or credit
// note: Zoho's full-page form (components/sales/sales-doc-form.tsx), the Edit
// one filled with the document as saved.

import { Suspense } from 'react';
import { useParams } from 'next/navigation';
import { AsyncPage } from '@/components/shared/async-state';
import { salesDocuments, type EditableSalesDoc } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { SalesDocumentForm } from './sales-doc-form';
import { SALES_DOC, type SalesDocKindZ } from './sales-docs';

export function NewSalesDocPage({ kind }: { kind: SalesDocKindZ }) {
  return <Suspense><SalesDocumentForm kind={kind} /></Suspense>;
}

/** Statuses that are past changing: Zoho offers no Edit on them either. */
const CLOSED: Record<SalesDocKindZ, string[]> = {
  estimate: ['converted'],
  'sales-order': ['cancelled'],
  challan: ['cancelled'],
  'credit-note': ['void'],
};

export function EditSalesDocPage({ kind }: { kind: SalesDocKindZ }) {
  const { id } = useParams<{ id: string }>();
  const state = useApi<EditableSalesDoc>(() => salesDocuments.getOne(kind, id), [kind, id]);
  return (
    <AsyncPage state={state}>
      {(doc) => CLOSED[kind].includes(doc.status) ? (
        <p className="p-6 text-sm text-muted-foreground" data-slot="edit-closed">
          {SALES_DOC[kind].noun} {doc.number} is {doc.status === 'converted' ? 'converted' : 'void'}, so it cannot be edited. Clone it to raise it again.
        </p>
      ) : (
        <Suspense><SalesDocumentForm kind={kind} editing={doc} /></Suspense>
      )}
    </AsyncPage>
  );
}
