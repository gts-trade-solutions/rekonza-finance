'use client';

// A debit note: an invoice charged too little, corrected upward.

import { Suspense } from 'react';
import { InvoiceForm } from '@/components/forms/invoice-form';

export default function NewDebitNotePage() {
  return <Suspense><InvoiceForm variant="debit_note" /></Suspense>;
}
