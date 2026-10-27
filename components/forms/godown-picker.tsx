'use client';

// Which godown a document's goods leave or enter. Shown only when the branch
// has more than one to choose from; left empty, the branch's main godown is
// used, as it always was.

import { FormRow } from '@/components/shared/form-layout';
import { Field } from '@/components/shared/form-bits';
import { inventory, type WarehouseRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

export function useGodowns(branchId: string): WarehouseRow[] {
  const canSee = usePermission('inventory', 'view');
  const list = useApi(() => (canSee ? inventory.warehouses() : Promise.resolve({ warehouses: [] as WarehouseRow[] })), [canSee]);
  return (list.data?.warehouses ?? []).filter((w) => w.isActive && (!w.branchId || w.branchId === branchId));
}

export function GodownPicker({ branchId, value, onChange, as = 'field' }: {
  branchId: string; value: string; onChange: (id: string) => void; as?: 'field' | 'row';
}) {
  const godowns = useGodowns(branchId);
  if (godowns.length < 2) return null;
  const select = (
    <div className="max-w-xs">
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Godown"
        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
        <option value="">Main godown</option>
        {godowns.map((g) => <option key={g.id} value={g.id}>{g.name}{g.code ? ` (${g.code})` : ''}</option>)}
      </select>
    </div>
  );
  return as === 'row'
    ? <FormRow label="Godown" hint="Where the goods leave or arrive">{select}</FormRow>
    : <Field label="Godown">{select}</Field>;
}
