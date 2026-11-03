'use client';

// Choosing several from a list: the chosen ones as chips, each with its ×,
// and the usual searchable list beneath to add another. The first chosen is
// marked when it means something (a default), as with TDS sections.

import { X } from 'lucide-react';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { cn } from '@/lib/utils';

export function MultiCombobox({
  options, value, onChange, placeholder, searchPlaceholder, firstLabel, className, id,
}: {
  options: ComboboxOption[];
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  /** A word for the first one chosen, such as "default". */
  firstLabel?: string;
  className?: string;
  id?: string;
}) {
  const left = options.filter((o) => !value.includes(o.value));
  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? v;
  return (
    <div className={cn('space-y-2', className)} data-slot="multi-combobox">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((v, i) => (
            <span key={v} className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/60 py-0.5 pl-2 pr-1 text-sm">
              <span className="truncate">{labelOf(v)}</span>
              {i === 0 && firstLabel && value.length > 1 && <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{firstLabel}</span>}
              <button
                type="button" aria-label={`Remove ${v}`}
                className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                onClick={() => onChange(value.filter((x) => x !== v))}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      {left.length > 0 && (
        <Combobox
          id={id}
          options={left}
          value=""
          onChange={(v) => { if (v && !value.includes(v)) onChange([...value, v]); }}
          placeholder={value.length ? 'Add another…' : placeholder}
          searchPlaceholder={searchPlaceholder}
          showAvatar={false}
        />
      )}
    </div>
  );
}
