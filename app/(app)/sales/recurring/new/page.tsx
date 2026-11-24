'use client';

import { Suspense } from 'react';
import { RecurringForm } from '@/components/sales/recurring-form';

export default function NewRecurringPage() {
  return <Suspense><RecurringForm /></Suspense>;
}
