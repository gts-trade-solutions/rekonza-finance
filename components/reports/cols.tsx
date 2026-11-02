'use client';

// Column makers for the report grids: text, a date, a number, money with an
// optional total, and a link to the record.

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Money } from '@/components/shared/money';
import type { GridColumn } from '@/components/shared/report-grid';
import { toRupees } from '@/lib/money';

const short = (d: string | null) => (d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN') : '—');

export function textCol<T>(key: string, header: string, get: (r: T) => string | null | undefined, opts: { strong?: boolean; muted?: boolean; href?: (r: T) => string | null } = {}): GridColumn<T> {
  return {
    key, header,
    cell: (r) => {
      const v = get(r) ?? '—';
      const href = opts.href?.(r);
      const body: ReactNode = <span className={opts.strong ? 'font-medium' : opts.muted ? 'text-xs text-muted-foreground' : undefined}>{v}</span>;
      return href ? <Link href={href} className="hover:underline">{body}</Link> : body;
    },
    csv: (r) => get(r) ?? '',
  };
}

export function dateCol<T>(key: string, header: string, get: (r: T) => string | null): GridColumn<T> {
  return { key, header, cell: (r) => <span className="tabular text-xs">{short(get(r))}</span>, csv: (r) => get(r) ?? '' };
}

export function numCol<T>(key: string, header: string, get: (r: T) => number, opts: { digits?: number; total?: boolean; suffix?: string } = {}): GridColumn<T> {
  const fmt = (n: number) => `${n.toLocaleString('en-IN', { maximumFractionDigits: opts.digits ?? 2 })}${opts.suffix ?? ''}`;
  return {
    key, header, align: 'right',
    cell: (r) => <span className="tabular">{fmt(get(r))}</span>,
    csv: (r) => get(r),
    total: opts.total ? (rs) => <span className="tabular">{fmt(rs.reduce((t, r) => t + get(r), 0))}</span> : undefined,
  };
}

export function moneyCol<T>(key: string, header: string, get: (r: T) => number | null, opts: { total?: boolean; showZero?: boolean; colored?: boolean } = {}): GridColumn<T> {
  return {
    key, header, align: 'right',
    cell: (r) => { const v = get(r); return v === null ? '—' : <Money value={v} showZero={opts.showZero ?? true} colored={opts.colored} />; },
    csv: (r) => { const v = get(r); return v === null ? '' : toRupees(v); },
    total: opts.total === false ? undefined : (rs) => <Money value={rs.reduce((t, r) => t + (get(r) ?? 0), 0)} colored={opts.colored} />,
  };
}
