'use client';

// Which series a new document is numbered in: the ordinary one, or one of the
// book's voucher types for that kind of document. Shows nothing when there are
// none, so a book that never made one never sees the question.

import { Field } from '@/components/shared/form-bits';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

export type VoucherDocType = 'INV' | 'CN' | 'DC' | 'EST' | 'SO' | 'PO';

interface VoucherType { id: string; docType: VoucherDocType; name: string; prefix: string; isActive: boolean }

export function VoucherTypePicker({ docType, ordinary, value, onChange }: {
  docType: VoucherDocType;
  /** What the ordinary series is called: "Credit note (CN series)". */
  ordinary: string;
  value: string;
  onChange: (id: string) => void;
}) {
  const state = useApi(() => api.get<{ types: VoucherType[] }>('/api/voucher-types'), []);
  const types = (state.data?.types ?? []).filter((t) => t.docType === docType && t.isActive);
  if (!types.length) return null;
  return (
    <Field label="Series" hint="A voucher type is numbered in its own series">
      <div>
        <select value={value} onChange={(e) => onChange(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
          <option value="">{ordinary}</option>
          {types.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.prefix} series)</option>)}
        </select>
      </div>
    </Field>
  );
}
