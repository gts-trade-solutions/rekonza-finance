'use client';

import { Suspense } from 'react';
import { InvoiceForm } from '@/components/forms/invoice-form';

export default function NewInvoicePage() {
  return <Suspense><InvoiceForm /></Suspense>;
}
