'use client';

// Zoho's Edit on a recurring invoice profile: the full form, saved back over it.

import { Suspense } from 'react';
import { useParams } from 'next/navigation';
import { AsyncPage } from '@/components/shared/async-state';
import { RecurringForm } from '@/components/sales/recurring-form';
import { recurringInvoices } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

export default function EditRecurringPage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi(() => recurringInvoices.get(id), [id]);
  return <AsyncPage state={state}>{(p) => <Suspense><RecurringForm editing={p} /></Suspense>}</AsyncPage>;
}
