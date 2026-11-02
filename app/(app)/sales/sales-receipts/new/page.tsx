'use client';

// A sale paid at the counter: the tax invoice and its receipt in one go.

import { Suspense } from 'react';
import { InvoiceForm } from '@/components/forms/invoice-form';

export default function NewSalesReceiptPage() {
  return <Suspense><InvoiceForm variant="receipt" /></Suspense>;
}
