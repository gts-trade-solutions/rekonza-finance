'use client';

// One document's printed copy: a quote, sales order, delivery challan, credit
// note, retainer, receipt, purchase order, vendor credit, payment advice or
// bill (components/print/document-print.tsx), with Send and Clone beside Print.

import { useParams } from 'next/navigation';
import { AsyncPage } from '@/components/shared/async-state';
import { DocumentPrintView } from '@/components/print/document-print';
import { DocumentScreenActions } from '@/components/shared/document-menu';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import type { PrintDoc } from '@/lib/print-doc';

export default function DocumentPrintPage() {
  const { kind, id } = useParams<{ kind: string; id: string }>();
  const state = useApi<PrintDoc>(() => api.get<PrintDoc>(`/api/print/${kind}/${id}`), [kind, id]);
  return (
    <AsyncPage state={state}>
      {(doc) => (
        <DocumentPrintView
          doc={doc}
          back={doc.kind === 'bill' ? `/purchases/bills/${doc.id}` : undefined}
          actions={<DocumentScreenActions kind={doc.kind} id={doc.id} />}
        />
      )}
    </AsyncPage>
  );
}
