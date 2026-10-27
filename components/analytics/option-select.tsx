'use client';

// A select over a short, fixed list of choices — aggregation, grain, format.
//
// Hands Base UI the `items` list so the closed trigger shows the chosen
// option's words ("Distinct count") rather than its key ("countd").

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

export interface Option<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export function OptionSelect<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  size = 'sm',
  className,
  disabled,
  label,
}: {
  value: T | '';
  onChange: (value: T) => void;
  options: Option<T>[];
  placeholder?: string;
  size?: 'sm' | 'default';
  className?: string;
  disabled?: boolean;
  /** Accessible name, for selects with no visible label beside them. */
  label?: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => v && onChange(v as T)}
      items={options.map((o) => ({ value: o.value, label: o.label }))}
      disabled={disabled}
    >
      <SelectTrigger size={size} className={cn('min-w-0', className)} aria-label={label}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="min-w-44">
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
