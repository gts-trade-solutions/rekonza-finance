'use client';

import type { LucideIcon } from 'lucide-react';
import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export function StatTile({
  label,
  value,
  sub,
  icon: Icon,
  tone = 'default',
  href,
  delta,
  deltaLabel = 'vs previous period',
  deltaGoodWhen = 'up',
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: LucideIcon;
  tone?: 'default' | 'positive' | 'warning' | 'danger';
  href?: string;
  /** Percentage change against the comparison period; null when there is nothing to compare against. */
  delta?: number | null;
  deltaLabel?: string;
  /**
   * Which direction is good news. Revenue rising is good; overdue receivables
   * rising is not, and colouring both green would be actively misleading.
   */
  deltaGoodWhen?: 'up' | 'down';
}) {
  const toneRing = {
    default: 'text-primary bg-primary/10',
    positive: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10',
    warning: 'text-amber-600 dark:text-amber-400 bg-amber-500/10',
    danger: 'text-red-600 dark:text-red-400 bg-red-500/10',
  }[tone];

  const body = (
    <Card
      data-slot="stat-tile"
      data-label={label}
      className={cn('p-4 transition-colors', href && 'hover:border-primary/40 hover:bg-accent/40')}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <p data-slot="stat-value" className="mt-1.5 text-2xl font-semibold tracking-tight tabular">
            {value}
          </p>
          {delta !== undefined && <Delta value={delta} label={deltaLabel} goodWhen={deltaGoodWhen} />}
          {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
        </div>
        {Icon && (
          <div className={cn('rounded-lg p-2', toneRing)}>
            <Icon className="size-4" />
          </div>
        )}
      </div>
    </Card>
  );

  return href ? <Link href={href}>{body}</Link> : body;
}

/** The "▲ 12.4% vs previous period" line under a figure. */
function Delta({
  value,
  label,
  goodWhen,
}: {
  value: number | null;
  label: string;
  goodWhen: 'up' | 'down';
}) {
  if (value === null || !Number.isFinite(value)) {
    return <p className="mt-1 text-xs text-muted-foreground">No comparable prior period</p>;
  }
  const flat = Math.abs(value) < 0.05;
  const up = value > 0;
  const good = flat ? null : up === (goodWhen === 'up');
  const Icon = flat ? Minus : up ? TrendingUp : TrendingDown;
  return (
    <p
      className={cn(
        'mt-1 flex items-center gap-1 text-xs font-medium',
        good === null
          ? 'text-muted-foreground'
          : good
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-red-600 dark:text-red-400',
      )}
    >
      <Icon className="size-3" />
      <span className="tabular">
        {flat ? '' : up ? '+' : ''}
        {value.toFixed(1)}%
      </span>
      <span className="font-normal text-muted-foreground">{label}</span>
    </p>
  );
}
