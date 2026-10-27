'use client';

// The tax invoice to print: components/print/invoice-print.tsx sets it out.

import { useParams } from 'next/navigation';
import { AsyncPage } from '@/components/shared/async-state';
import { PrintView } from '@/components/print/invoice-print';
import { invoices as invoiceApi, type InvoiceDetail } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

export default function TaxInvoicePrintPage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<InvoiceDetail>(() => invoiceApi.get(id), [id]);
  return <AsyncPage state={state}>{(inv) => <PrintView inv={inv} />}</AsyncPage>;
}
