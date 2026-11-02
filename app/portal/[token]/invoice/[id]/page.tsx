'use client';

// One invoice, opened from the customer's portal: the printed invoice, a way
// to save it as a PDF, and Pay when the business takes online payment.

import { use } from 'react';
import Link from 'next/link';
import { AlertCircle, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PrintView } from '@/components/print/invoice-print';
import { api, type InvoiceDetail } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

export default function PortalInvoicePage({ params }: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = use(params);
  const state = useApi(() => api.get<InvoiceDetail>(`/api/portal/${encodeURIComponent(token)}/invoice/${encodeURIComponent(id)}`), [token, id]);
  return (
    <main className="min-h-screen bg-muted/30 px-4 py-6 print:bg-white print:p-0">
      <div className="mx-auto max-w-[900px] space-y-3">
        <Button variant="outline" size="sm" asChild className="no-print"><Link href={`/portal/${token}`}><ArrowLeft className="size-3.5" /> Your account</Link></Button>
        {state.error ? (
          <p className="flex items-center gap-2 text-sm"><AlertCircle className="size-4 text-destructive" /> {state.error}</p>
        ) : state.data ? <PrintView inv={state.data} shared /> : <p className="text-sm text-muted-foreground">Opening…</p>}
      </div>
    </main>
  );
}
