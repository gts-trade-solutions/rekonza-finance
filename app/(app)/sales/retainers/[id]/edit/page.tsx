'use client';

// Zoho's Edit on a service (retainer) invoice: the full form, saved back over it.

import { Suspense } from 'react';
import { useParams } from 'next/navigation';
import { AsyncPage } from '@/components/shared/async-state';
import { RetainerForm } from '@/components/sales/retainer-form';
import { retainers } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

export default function EditRetainerPage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi(() => retainers.get(id), [id]);
  return <AsyncPage state={state}>{(r) => <Suspense><RetainerForm editing={r} /></Suspense>}</AsyncPage>;
}
