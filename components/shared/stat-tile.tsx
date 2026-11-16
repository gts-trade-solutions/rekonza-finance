'use client';

// A figure tile as Zoho Books draws its summary figures: a white box with a
// lavender hairline and 12px corners, the label in 13px grey, the figure in
// 18px dark type, and a soft round icon. No coloured edges or washes: Zoho
// keeps colour for what needs attention, so only a bad figure (overdue, at
// risk) takes Zoho's orange, and a warning its amber.
//
// The colour names (TileColor) stay in the API so callers need not change;
// they now only tint the icon.

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
  const own = TILE_COLORS[color ?? autoColor(label, tone)];
  const bad = tone === 'danger' || color === 'red';

  const body = (
    <Card
      data-slot="stat-tile"
      data-label={label}
      data-color={color}
      className={cn('gap-0 px-5 py-4 transition-colors', href && 'hover:border-primary/40')}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] text-[#4a4d63] dark:text-muted-foreground">{label}</p>
          <p data-slot="stat-value" className={cn('mt-1 text-[18px] font-medium leading-snug tabular text-[#222536] dark:text-foreground', bad && 'text-overdue dark:text-overdue', tone === 'warning' && 'text-warning dark:text-warning')}>
            {value}
          </p>
          {delta !== undefined && <Delta value={delta} label={deltaLabel} goodWhen={deltaGoodWhen} />}
          {sub && <p className="mt-1 text-[12px] text-muted-foreground">{sub}</p>}
        </div>
        {Icon && (
          <div className={cn('grid size-9 shrink-0 place-items-center rounded-full', own.chip)}>
            <Icon className="size-4" />
          </div>
        )}
      </div>
    </Card>
  );

  return href ? <Link href={href}>{body}</Link> : body;
}

/**
 * The same look for a figure tile a page lays out itself. Zoho's: no card
 * colour, the label in grey; the chip a soft tint fixed by the label.
 */
export function tileColors(label: string, tone: 'default' | 'positive' | 'warning' | 'danger' = 'default') {
  const c = TILE_COLORS[autoColor(label, tone)];
  return {
    card: 'border-card-border',
    label: cn('!text-[13px] !font-normal !normal-case !tracking-normal text-[#4a4d63] dark:text-muted-foreground', tone === 'danger' && '!text-overdue', tone === 'warning' && '!text-warning'),
    chip: c.chip,
  };
}

/** The tone's colour where it has one; otherwise one of the cool hues, fixed by the label. */
function autoColor(label: string, tone: 'default' | 'positive' | 'warning' | 'danger'): TileColor {
  if (tone === 'positive') return 'emerald';
  if (tone === 'warning') return 'amber';
  if (tone === 'danger') return 'red';
  const cool: TileColor[] = ['blue', 'violet', 'teal', 'indigo', 'sky', 'cyan'];
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return cool[h % cool.length];
}

export type TileColor = 'red' | 'blue' | 'orange' | 'emerald' | 'violet' | 'sky' | 'amber' | 'teal' | 'indigo' | 'rose' | 'fuchsia' | 'cyan' | 'lime';

/** Whole class names, so Tailwind sees every one of them. Soft round chips, as Zoho's summary icons. */
const TILE_COLORS: Record<TileColor, { chip: string }> = {
  red: { chip: 'bg-[#fde3d8] text-overdue' },
  blue: { chip: 'bg-[#e1ebfc] text-[#1c5bd9]' },
  orange: { chip: 'bg-[#fae6d5] text-[#c46614]' },
  emerald: { chip: 'bg-[#d9f4e8] text-[#13865a]' },
  violet: { chip: 'bg-[#eee6fa] text-[#713dbf]' },
  sky: { chip: 'bg-[#dbeff9] text-[#0d789e]' },
  amber: { chip: 'bg-[#fae9c8] text-[#9e6a03]' },
  teal: { chip: 'bg-[#d8f2ef] text-[#0e7c72]' },
  indigo: { chip: 'bg-[#e1e5fc] text-[#3f4bbd]' },
  rose: { chip: 'bg-[#fbe2e7] text-[#c2244c]' },
  fuchsia: { chip: 'bg-[#f8e1f6] text-[#a1259b]' },
  cyan: { chip: 'bg-[#defcfc] text-[#068080]' },
  lime: { chip: 'bg-[#eaf6d3] text-[#4d7a0b]' },
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
