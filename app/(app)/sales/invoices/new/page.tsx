'use client';

// New Invoice, or — from the list's New ▾ → New Bill Of Supply (?type=bill-of-supply) —
// a bill of supply for exempt, nil-rated or non-GST goods (components/forms/invoice-form.tsx).

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { InvoiceForm } from '@/components/forms/invoice-form';

function Form() {
  const type = useSearchParams().get('type');
  return <InvoiceForm variant={type === 'bill-of-supply' ? 'bill_of_supply' : 'invoice'} />;
}

export default function NewInvoicePage() {
  return <Suspense><Form /></Suspense>;
}
