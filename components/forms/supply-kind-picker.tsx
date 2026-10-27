'use client';

// ─────────────────────────────────────────────────────────────────────────────
// What is this invoice for — goods, services, or both?
//
// It is not decoration. GST treats the two differently: goods carry an HSN code
// and services carry a SAC, the place-of-supply rules diverge, and GSTR-1's HSN
// summary reports them in separate blocks. Declaring it up front lets the line
// editor offer only the codes and items that can legally appear, which is what
// stops the wrong kind of code reaching the return.
//
// Both toggles can be on at once — a garage billing parts *and* labour on one
// invoice is the normal case, not an edge case.
// ─────────────────────────────────────────────────────────────────────────────

import { Package, Wrench } from 'lucide-react';
import type { SupplyKind } from '@/lib/types';
import { cn } from '@/lib/utils';

const OPTIONS = [
  { key: 'goods' as const, label: 'Goods', icon: Package, hint: 'HSN codes' },
  { key: 'service' as const, label: 'Services', icon: Wrench, hint: 'SAC codes' },
];

export function SupplyKindPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: SupplyKind;
  onChange: (v: SupplyKind) => void;
  disabled?: boolean;
}) {
  const on = (k: 'goods' | 'service') => value === 'both' || value === k;

  const toggle = (k: 'goods' | 'service') => {
    const other = k === 'goods' ? 'service' : 'goods';
    if (value === 'both') {
      onChange(other); // turning one off leaves the other
    } else if (value === k) {
      // Refuse to leave nothing selected — an invoice is always for something.
    } else {
      onChange('both');
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-[3px] border p-0.5">
        {OPTIONS.map((o) => (
          <button
            key={o.key}
            type="button"
            role="checkbox"
            aria-checked={on(o.key)}
            aria-label={o.label}
            disabled={disabled}
            data-slot="supply-kind"
            data-kind={o.key}
            onClick={() => toggle(o.key)}
            className={cn(
              'flex items-center gap-1.5 rounded-[2px] px-3 py-1.5 text-xs font-medium transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-50',
              on(o.key)
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <o.icon className="size-3.5" />
            {o.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {value === 'both'
          ? 'Both HSN and SAC codes are available on the lines below.'
          : value === 'goods'
            ? 'Lines may use HSN codes only.'
            : 'Lines may use SAC codes only.'}
      </p>
    </div>
  );
}
