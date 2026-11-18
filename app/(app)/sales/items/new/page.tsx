'use client';

// Zoho's "New Item" page (components/sales/item-form.tsx). ?clone=<id> starts
// it from an existing item, as "More → Clone Item" does: everything but the
// SKU, which is the item's own, and its opening stock.

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ItemForm } from '@/components/sales/item-form';
import { AsyncPage } from '@/components/shared/async-state';
import { items } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

function CloneOf({ id }: { id: string }) {
  const state = useApi(() => items.get(id), [id]);
  return <AsyncPage state={state}>{(d) => <ItemForm clone={d.item} />}</AsyncPage>;
}

function NewItem() {
  const clone = useSearchParams().get('clone');
  return clone ? <CloneOf id={clone} /> : <ItemForm />;
}

export default function NewItemPage() {
  return (
    <Suspense>
      <NewItem />
    </Suspense>
  );
}
