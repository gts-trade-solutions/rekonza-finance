'use client';

import { Suspense } from 'react';
import { BillForm } from '@/components/forms/bill-form';

export default function NewBillPage() {
  return <Suspense><BillForm /></Suspense>;
}
