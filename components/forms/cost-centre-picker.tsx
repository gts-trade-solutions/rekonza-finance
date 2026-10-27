'use client';

// Which cost centre a document's or line's income and expense belong to.
// Shows nothing when the book has no cost centres, or has switched them off.

import { FormRow } from '@/components/shared/form-layout';
import { Field } from '@/components/shared/form-bits';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { cn } from '@/lib/utils';

interface Centre { id: string; code: string; name: string; category: string | null; isActive: boolean }

/** The book's active cost centres, or none when the part is switched off. */
export function useCostCentres(): Centre[] {
  const centres = useApi(() => api.get<{ centres: Centre[] }>('/api/cost-centres'), []);
  const policies = useApi(() => api.get<{ features?: { costCentres?: boolean } }>('/api/settings/policies'), []);
  if (policies.data?.features?.costCentres === false) return [];
  return (centres.data?.centres ?? []).filter((c) => c.isActive);
}

export function CostCentreSelect({ centres, value, onChange, className }: {
  centres: Centre[]; value: string; onChange: (id: string) => void; className?: string;
}) {
  const categories = [...new Set(centres.map((c) => c.category ?? ''))];
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Cost centre"
      className={cn('h-9 w-full rounded-md border border-input bg-background px-2 text-sm', className)}>
      <option value="">No cost centre</option>
      {categories.map((cat) => {
        const opts = centres.filter((c) => (c.category ?? '') === cat).map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>);
        return cat ? <optgroup key={cat} label={cat}>{opts}</optgroup> : opts;
      })}
    </select>
  );
}

/** For a whole document: on its income and expense when it posts. */
export function CostCentrePicker({ value, onChange, as = 'field' }: { value: string; onChange: (id: string) => void; as?: 'field' | 'row' }) {
  const centres = useCostCentres();
  if (!centres.length) return null;
  const select = <div className="max-w-xs"><CostCentreSelect centres={centres} value={value} onChange={onChange} /></div>;
  return as === 'row'
    ? <FormRow label="Cost centre" hint="Its income and expense are counted there">{select}</FormRow>
    : <Field label="Cost centre">{select}</Field>;
}
