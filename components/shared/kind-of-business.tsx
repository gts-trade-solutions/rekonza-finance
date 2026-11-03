'use client';

// "Kind of business" on a customer or vendor: a dropdown of the kinds a party
// in India is registered as (lib/company-profile.ts), filled from the GSTIN
// and the CIN. A value saved before the dropdown existed stays selectable.

import { PARTY_KINDS } from '@/lib/company-profile';
import { cn } from '@/lib/utils';

export function KindOfBusinessSelect({ value, onChange, disabled, className }: {
  value: string | null | undefined;
  onChange: (v: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const v = value ?? '';
  const known = (PARTY_KINDS as readonly string[]).includes(v);
  return (
    <select value={v} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-label="Kind of business" data-slot="kind-of-business"
      className={cn('h-9 w-full rounded-md border border-input bg-background px-2 text-sm', className)}>
      <option value="">Choose the kind</option>
      {PARTY_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
      {v && !known && <option value={v}>{v}</option>}
    </select>
  );
}
