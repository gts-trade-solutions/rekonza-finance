'use client';

// Zoho's "Edit Item" page: the same form as a new item, filled.

import { useParams } from 'next/navigation';
import { ItemForm } from '@/components/sales/item-form';
import { AsyncPage } from '@/components/shared/async-state';
import { items } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

export default function EditItemPage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi(() => items.get(id), [id]);
  return <AsyncPage state={state}>{(d) => <ItemForm editing={d.item} />}</AsyncPage>;
}
