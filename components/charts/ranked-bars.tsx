'use client';

// Horizontal ranked bars: name, proportional bar, amount, share.
//
// Preferred over a vertical bar chart wherever the category is a name rather
// than a date. Names read left-to-right, so putting them on the Y axis avoids
// the rotated, truncated labels that make vertical charts of customer names
// unreadable — and the bar can then carry the amount and percentage inline
// instead of forcing a hover.

import Link from 'next/link';
import { formatINR } from '@/lib/money';
import { cn } from '@/lib/utils';

export interface RankedRow {
  id: string;
  name: string;
  value: number; // paise
  pct: number;
  /** Optional second figure rendered under the name, e.g. the overdue slice. */
  note?: string;
  href?: string;
  /** Renders the bar in the danger tone — used for anything past due. */
  alert?: boolean;
}

export function RankedBars({
  rows,
  emptyMessage = 'Nothing outstanding.',
  tone = 'primary',
}: {
  rows: RankedRow[];
  emptyMessage?: string;
  tone?: 'primary' | 'warning';
}) {
  if (rows.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  // Scale to the largest row, not to the total — otherwise every bar in a long
  // tail collapses to a sliver and the chart stops distinguishing anything.
  const max = Math.max(...rows.map((r) => r.value), 1);

  return (
    <ul className="space-y-2.5">
      {rows.map((r) => {
        const body = (
          <>
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{r.name}</span>
              <span className="shrink-0 tabular text-xs font-medium">{formatINR(r.value)}</span>
              <span className="w-11 shrink-0 text-right tabular text-[11px] text-muted-foreground">
                {r.pct.toFixed(1)}%
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  'h-full rounded-full transition-[width]',
                  r.alert ? 'bg-destructive' : tone === 'warning' ? 'bg-warning' : 'bg-primary',
                )}
                style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }}
              />
            </div>
            {r.note && <p className="mt-1 text-[11px] text-muted-foreground">{r.note}</p>}
          </>
        );

        return (
          <li key={r.id}>
            {r.href ? (
              <Link href={r.href} className="block rounded-sm px-1 py-0.5 transition-colors hover:bg-accent/50">
                {body}
              </Link>
            ) : (
              <div className="px-1 py-0.5">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
