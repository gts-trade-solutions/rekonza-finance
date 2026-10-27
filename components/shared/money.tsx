'use client';

import { formatINR, formatINRCompact, formatINRWhole } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { Paise } from '@/lib/types';

/** Right-aligned tabular money cell — the default way to render any amount. */
export function Money({
  value,
  className,
  whole = false,
  compact = false,
  colored = false,
  showZero = true,
}: {
  value: Paise;
  className?: string;
  whole?: boolean;
  compact?: boolean;
  colored?: boolean;
  showZero?: boolean;
}) {
  if (!showZero && value === 0) return <span className={cn('num text-muted-foreground', className)}>—</span>;
  const text = compact ? formatINRCompact(value) : whole ? formatINRWhole(value) : formatINR(value);
  return (
    <span
      className={cn(
        'num',
        colored && value < 0 && 'text-destructive',
        colored && value > 0 && 'text-emerald-600 dark:text-emerald-400',
        className,
      )}
    >
      {text}
    </span>
  );
}
