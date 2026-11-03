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
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: LucideIcon;
  tone?: 'default' | 'positive' | 'warning' | 'danger';
  /** A colour of its own (the dashboard), so each figure is told apart at a glance. */
  color?: TileColor;
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
  const own = color ? TILE_COLORS[color] : null;

  const body = (
    <Card
      data-slot="stat-tile"
      data-label={label}
      data-color={color}
      className={cn(
        'p-4 transition-colors',
        own && cn('border-l-4', own.card),
        href && (own ? 'hover:brightness-[0.98]' : 'hover:border-primary/40 hover:bg-accent/40'),
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={cn('text-xs font-medium uppercase tracking-wide', own ? own.label : 'text-muted-foreground')}>{label}</p>
          <p data-slot="stat-value" className={cn('mt-1.5 text-2xl font-semibold tracking-tight tabular', own && (tone === 'danger' || color === 'red') && 'text-red-600 dark:text-red-400')}>
            {value}
          </p>
          {delta !== undefined && <Delta value={delta} label={deltaLabel} goodWhen={deltaGoodWhen} />}
          {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
        </div>
        {Icon && (
          <div className={cn('rounded-lg p-2', own ? own.chip : toneRing)}>
            <Icon className="size-4" />
          </div>
        )}
      </div>
    </Card>
  );

  return href ? <Link href={href}>{body}</Link> : body;
}

export type TileColor = 'red' | 'blue' | 'orange' | 'emerald' | 'violet' | 'sky' | 'amber' | 'teal' | 'indigo' | 'rose' | 'fuchsia' | 'cyan' | 'lime';

/** Whole class names, so Tailwind sees every one of them. */
const TILE_COLORS: Record<TileColor, { card: string; label: string; chip: string }> = {
  red: { card: 'border-l-red-600 bg-gradient-to-br from-red-500/10 to-transparent', label: 'text-red-700 dark:text-red-300', chip: 'bg-red-600 text-white' },
  blue: { card: 'border-l-blue-500 bg-gradient-to-br from-blue-500/10 to-transparent', label: 'text-blue-700 dark:text-blue-300', chip: 'bg-blue-500 text-white' },
  orange: { card: 'border-l-orange-500 bg-gradient-to-br from-orange-500/10 to-transparent', label: 'text-orange-700 dark:text-orange-300', chip: 'bg-orange-500 text-white' },
  emerald: { card: 'border-l-emerald-500 bg-gradient-to-br from-emerald-500/10 to-transparent', label: 'text-emerald-700 dark:text-emerald-300', chip: 'bg-emerald-500 text-white' },
  violet: { card: 'border-l-violet-500 bg-gradient-to-br from-violet-500/10 to-transparent', label: 'text-violet-700 dark:text-violet-300', chip: 'bg-violet-500 text-white' },
  sky: { card: 'border-l-sky-500 bg-gradient-to-br from-sky-500/10 to-transparent', label: 'text-sky-700 dark:text-sky-300', chip: 'bg-sky-500 text-white' },
  amber: { card: 'border-l-amber-500 bg-gradient-to-br from-amber-500/10 to-transparent', label: 'text-amber-700 dark:text-amber-300', chip: 'bg-amber-500 text-white' },
  teal: { card: 'border-l-teal-500 bg-gradient-to-br from-teal-500/10 to-transparent', label: 'text-teal-700 dark:text-teal-300', chip: 'bg-teal-500 text-white' },
  indigo: { card: 'border-l-indigo-500 bg-gradient-to-br from-indigo-500/10 to-transparent', label: 'text-indigo-700 dark:text-indigo-300', chip: 'bg-indigo-500 text-white' },
  rose: { card: 'border-l-rose-500 bg-gradient-to-br from-rose-500/10 to-transparent', label: 'text-rose-700 dark:text-rose-300', chip: 'bg-rose-500 text-white' },
  fuchsia: { card: 'border-l-fuchsia-500 bg-gradient-to-br from-fuchsia-500/10 to-transparent', label: 'text-fuchsia-700 dark:text-fuchsia-300', chip: 'bg-fuchsia-500 text-white' },
  cyan: { card: 'border-l-cyan-500 bg-gradient-to-br from-cyan-500/10 to-transparent', label: 'text-cyan-700 dark:text-cyan-300', chip: 'bg-cyan-500 text-white' },
  lime: { card: 'border-l-lime-500 bg-gradient-to-br from-lime-500/10 to-transparent', label: 'text-lime-700 dark:text-lime-300', chip: 'bg-lime-600 text-white' },
};

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
