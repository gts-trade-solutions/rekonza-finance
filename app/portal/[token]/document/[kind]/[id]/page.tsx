'use client';

// One of the contact's documents, opened from the portal: a quote, order,
// credit note, receipt, purchase order … as printed, with a way to save it as
// a PDF.

import { use } from 'react';
import Link from 'next/link';
import { AlertCircle, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DocumentPrintView } from '@/components/print/document-print';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import type { PrintDoc } from '@/lib/print-doc';

export default function PortalDocumentPage({ params }: { params: Promise<{ token: string; kind: string; id: string }> }) {
  const { token, kind, id } = use(params);
  const state = useApi(() => api.get<PrintDoc>(`/api/portal/${encodeURIComponent(token)}/document/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`), [token, kind, id]);
  return (
    <main className="min-h-screen bg-muted/30 px-4 py-6 print:bg-white print:p-0">
      <div className="mx-auto max-w-[900px] space-y-3">
        <Button variant="outline" size="sm" asChild className="no-print"><Link href={`/portal/${token}`}><ArrowLeft className="size-3.5" /> Your account</Link></Button>
        {state.error ? (
          <p className="flex items-center gap-2 text-sm"><AlertCircle className="size-4 text-destructive" /> {state.error}</p>
        ) : state.data ? <DocumentPrintView doc={state.data} shared /> : <p className="text-sm text-muted-foreground">Opening…</p>}
      </div>
    </main>
  );
}
