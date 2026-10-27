'use client';

// A document opened from a link the business sent: an invoice (the
// recipient's copy) or an employee's payslip. No sign-in; a way to print it or
// save it as a PDF.

import { use } from 'react';
import { AlertCircle, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PrintView } from '@/components/print/invoice-print';
import { Payslip } from '@/components/payroll/payslip';
import { api, type InvoiceDetail } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import type { Run } from '@/app/(app)/payroll/runs/[id]/page';

type Shared = ({ kind: 'invoice' } & InvoiceDetail) | { kind: 'payslip'; run: Run };

export default function SharedDocumentPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const state = useApi(() => api.get<Shared>(`/api/share/${encodeURIComponent(token)}`), [token]);
  const d = state.data;
  return (
    <main className="min-h-screen bg-muted/30 px-4 py-6 print:bg-white print:p-0">
      <div className="mx-auto max-w-[900px]">
        {state.error ? (
          <div className="mx-auto mt-24 max-w-md text-center">
            <AlertCircle className="mx-auto mb-3 size-8 text-muted-foreground" />
            <h1 className="text-lg font-semibold">This link cannot be opened</h1>
            <p className="mt-2 text-sm text-muted-foreground">{state.error}</p>
          </div>
        ) : !d ? (
          <p className="mt-24 text-center text-sm text-muted-foreground">Opening…</p>
        ) : d.kind === 'payslip' ? (
          <div className="space-y-4">
            <div className="flex justify-end no-print">
              <Button size="sm" className="gap-1.5" onClick={() => window.print()}><Printer className="size-3.5" /> Print or save as PDF</Button>
            </div>
            <Payslip run={d.run} l={d.run.lines[0]} last />
          </div>
        ) : (
          <PrintView inv={d} shared />
        )}
      </div>
    </main>
  );
}
