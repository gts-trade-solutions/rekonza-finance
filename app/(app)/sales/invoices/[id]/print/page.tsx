'use client';

// The tax invoice to print: components/print/invoice-print.tsx sets it out.
// ?as=delivery-note or ?as=packing-slip prints the same goods without their
// prices instead (Zoho's PDF/Print ▾ → Print Delivery Note / Print Packing Slip).

import { useParams, useSearchParams } from 'next/navigation';
import { AsyncPage } from '@/components/shared/async-state';
import { PrintView } from '@/components/print/invoice-print';
import { PackingPrint, type PackingKind } from '@/components/print/packing-print';
import { invoices as invoiceApi, type InvoiceDetail } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

const PACKING: PackingKind[] = ['delivery-note', 'packing-slip'];

export default function TaxInvoicePrintPage() {
  const { id } = useParams<{ id: string }>();
  const as = useSearchParams().get('as');
  const state = useApi<InvoiceDetail>(() => invoiceApi.get(id), [id]);
  const packing = PACKING.find((k) => k === as);
  return <AsyncPage state={state}>{(inv) => (packing ? <PackingPrint inv={inv} kind={packing} /> : <PrintView inv={inv} />)}</AsyncPage>;
}
