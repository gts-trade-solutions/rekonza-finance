'use client';

// ─────────────────────────────────────────────────────────────────────────────
// The report's filters: one row, above every tile, applied to all of them.
//
// One row and not one per chart, because a dashboard where each tile is
// filtered differently answers a different question in every corner, and the
// reader cannot tell. Anything a single tile needs on its own belongs in that
// tile's definition, not in a control beside it.
//
// Date ranges are anchored to the data, not to today: a file of last year's
// sales should offer "latest financial year" as the year it actually holds.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useState } from 'react';
import { CalendarRange, Funnel, Hash, Plus, Search, Type, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { MONTHS, fyLabel, fyStartYear } from '@/lib/analytics/dates';
import { formatValue } from '@/lib/analytics/format';
import { applyFilters, columnOf, dateSpan, distinctValues } from '@/lib/analytics/query';
import type { Cell, ColumnSchema, DatasetData, Filter } from '@/lib/analytics/types';
import { cn } from '@/lib/utils';

const isNumeric = (c: ColumnSchema) => c.type === 'number' || c.type === 'currency' || c.type === 'percent';

const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

// ── Date ranges, anchored on the latest date in the data ─────────────────────

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const shift = (y: number, m: number, k: number): [number, number] => {
  const t = y * 12 + (m - 1) + k;
  return [Math.floor(t / 12), (t % 12) + 1];
};
const start = (y: number, m: number) => `${y}-${pad(m)}-01`;
const end = (y: number, m: number) => `${y}-${pad(m)}-${pad(lastDay(y, m))}`;

interface DatePreset {
  key: string;
  label: string;
  from: string;
  to: string;
}

export function datePresets(span: { min: string; max: string }): DatePreset[] {
  const [y, m] = span.max.split('-').map(Number);
  const fy = fyStartYear(span.max);
  // Financial quarters start in April, July, October and January.
  const qStart = m >= 4 ? 4 + Math.floor((m - 4) / 3) * 3 : 1;
  const [qe_y, qe_m] = shift(y, qStart, 2);
  const [l12_y, l12_m] = shift(y, m, -11);
  const out: DatePreset[] = [
    { key: 'month', label: `Latest month · ${MONTHS[m - 1]} ${y}`, from: start(y, m), to: end(y, m) },
    { key: 'quarter', label: 'Latest financial quarter', from: start(y, qStart), to: end(qe_y, qe_m) },
    { key: 'l12m', label: 'Last 12 months', from: start(l12_y, l12_m), to: end(y, m) },
    { key: 'fy', label: `Latest financial year · ${fyLabel(fy)}`, from: `${fy}-04-01`, to: `${fy + 1}-03-31` },
  ];
  if (span.min < `${fy}-04-01`) {
    out.push({ key: 'pfy', label: `Previous financial year · ${fyLabel(fy - 1)}`, from: `${fy - 1}-04-01`, to: `${fy}-03-31` });
  }
  return out;
}

// ── Summaries on the chips ───────────────────────────────────────────────────

function summary(f: Filter, col: ColumnSchema, data: DatasetData): string {
  if (f.op === 'in') {
    if (!f.values) return 'All';
    if (f.values.length === 0) return 'None';
    const label = (v: Cell) => (v === null ? '(Blank)' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v));
    const names = f.values.map(label);
    return names.length <= 2 ? names.join(', ') : `${names[0]} +${names.length - 1} more`;
  }
  const from = f.from ?? null;
  const to = f.to ?? null;
  if (from === null && to === null) return 'All';
  if (col.type === 'date') {
    const span = dateSpan(data, col.key);
    const preset = span && datePresets(span).find((p) => p.from === from && p.to === to);
    if (preset) return preset.label.split(' · ').pop()!;
    if (from !== null && to !== null) return `${fmtDate(String(from))} – ${fmtDate(String(to))}`;
    return from !== null ? `From ${fmtDate(String(from))}` : `Up to ${fmtDate(String(to))}`;
  }
  const fmt = col.type === 'currency' ? 'inr' : col.type === 'percent' ? 'percent' : 'number';
  const n = (v: string | number | null) => formatValue(Number(v), fmt);
  if (from !== null && to !== null) return `${n(from)} – ${n(to)}`;
  return from !== null ? `≥ ${n(from)}` : `≤ ${n(to)}`;
}

/** "Region: North, South · Month: FY 2025-26" — for a printed page, where there are no chips. */
export function describeFilters(data: DatasetData, filters: Filter[]): string {
  const parts = filters
    .map((f) => {
      const col = columnOf(data, f.column);
      if (!col) return null;
      const s = summary(f, col, data);
      return s === 'All' ? null : `${col.label}: ${s}`;
    })
    .filter(Boolean);
  return parts.length ? parts.join(' · ') : 'All data';
}

// ── The bar ──────────────────────────────────────────────────────────────────

export function FilterBar({
  data,
  filters,
  onChange,
  note,
}: {
  data: DatasetData;
  filters: Filter[];
  onChange: (filters: Filter[]) => void;
  /** Said at the end of the row — e.g. that a reader's filters are not saved. */
  note?: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const shown = useMemo(() => applyFilters(data, filters).length, [data, filters]);

  const active = filters.filter((f) => columnOf(data, f.column));
  const available = data.columns.filter((c) => !active.some((f) => f.column === c.key));

  const put = (f: Filter) => onChange(active.map((x) => (x.column === f.column ? f : x)));
  const remove = (key: string) => onChange(active.filter((x) => x.column !== key));
  const add = (c: ColumnSchema) => {
    onChange([...active, { column: c.key, op: c.type === 'date' || isNumeric(c) ? 'between' : 'in' }]);
    setAdding(false);
    setOpen(c.key);
  };

  const groups: { label: string; icon: typeof Type; cols: ColumnSchema[] }[] = [
    { label: 'Dates', icon: CalendarRange, cols: available.filter((c) => c.type === 'date') },
    { label: 'Fields', icon: Type, cols: available.filter((c) => c.type !== 'date' && !(isNumeric(c) && c.role === 'measure')) },
    { label: 'Numbers', icon: Hash, cols: available.filter((c) => isNumeric(c) && c.role === 'measure') },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[3px] border bg-card px-3 py-2 no-print" data-slot="filter-bar">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Funnel className="size-3.5" /> Filters
      </span>

      {active.map((f) => {
        const col = columnOf(data, f.column)!;
        return (
          <div key={f.column} className="flex items-center rounded-[3px] border bg-surface text-xs" data-slot="filter-chip">
            <Popover open={open === f.column} onOpenChange={(o) => setOpen(o ? f.column : null)}>
              <PopoverTrigger className="flex max-w-72 items-center gap-1 py-1 pl-2 pr-1.5 outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/25">
                <span className="text-muted-foreground">{col.label}:</span>
                <span className="truncate font-medium">{summary(f, col, data)}</span>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-80 p-3">
                <FilterEditor data={data} col={col} filter={f} onChange={put} onDone={() => setOpen(null)} />
              </PopoverContent>
            </Popover>
            <button
              type="button"
              onClick={() => remove(f.column)}
              className="grid size-6 place-items-center border-l text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={`Remove the ${col.label} filter`}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}

      <Popover open={adding} onOpenChange={setAdding}>
        <PopoverTrigger
          disabled={!available.length}
          className="flex h-7 items-center gap-1 rounded-[3px] border border-dashed px-2 text-xs text-muted-foreground outline-none hover:border-primary/50 hover:text-foreground disabled:opacity-50"
          data-slot="filter-add"
        >
          <Plus className="size-3.5" /> Add filter
        </PopoverTrigger>
        <PopoverContent align="start" className="max-h-80 w-64 overflow-y-auto p-1.5 thin-scroll">
          {groups.filter((g) => g.cols.length).map((g) => (
            <div key={g.label} className="py-1">
              <p className="micro-label px-2 pb-1">{g.label}</p>
              {g.cols.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => add(c)}
                  className="flex w-full items-center gap-2 rounded-[3px] px-2 py-1.5 text-left text-xs hover:bg-accent"
                >
                  <g.icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{c.label}</span>
                </button>
              ))}
            </div>
          ))}
        </PopoverContent>
      </Popover>

      {active.length > 0 && (
        <button type="button" onClick={() => onChange([])} className="text-xs text-primary hover:underline">
          Clear all
        </button>
      )}

      <span className="ml-auto text-[11px] text-muted-foreground" data-slot="filter-count">
        {active.length ? `${shown.toLocaleString('en-IN')} of ${data.rows.length.toLocaleString('en-IN')} rows` : `${data.rows.length.toLocaleString('en-IN')} rows`}
        {note ? ` · ${note}` : ''}
      </span>
    </div>
  );
}

// ── Editors ──────────────────────────────────────────────────────────────────

function FilterEditor({
  data, col, filter, onChange, onDone,
}: { data: DatasetData; col: ColumnSchema; filter: Filter; onChange: (f: Filter) => void; onDone: () => void }) {
  if (filter.op === 'in') return <ValuesEditor data={data} col={col} filter={filter} onChange={onChange} />;
  if (col.type === 'date') return <DateEditor data={data} col={col} filter={filter} onChange={onChange} onDone={onDone} />;
  return <RangeEditor col={col} filter={filter} onChange={onChange} onDone={onDone} />;
}

function ValuesEditor({ data, col, filter, onChange }: { data: DatasetData; col: ColumnSchema; filter: Filter; onChange: (f: Filter) => void }) {
  const all = useMemo(() => distinctValues(data, col.key, 500), [data, col.key]);
  const [q, setQ] = useState('');
  const key = (v: Cell) => (v === null ? '\u0000' : String(v));
  const selected = new Set((filter.values ?? all.map((a) => a.value)).map(key));
  const list = q ? all.filter((a) => a.label.toLowerCase().includes(q.toLowerCase())) : all;

  const commit = (next: Set<string>) => {
    // Everything ticked is the same as no filter, and is stored as none.
    if (next.size === all.length) return onChange({ column: col.key, op: 'in' });
    onChange({ column: col.key, op: 'in', values: all.filter((a) => next.has(key(a.value))).map((a) => a.value) });
  };
  const toggle = (v: Cell) => {
    const next = new Set(selected);
    if (next.has(key(v))) next.delete(key(v));
    else next.add(key(v));
    commit(next);
  };

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium">{col.label}</p>
      {all.length > 8 && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search values" className="h-8 pl-7 text-xs" />
        </div>
      )}
      <div className="flex gap-3 text-xs">
        <button type="button" className="text-primary hover:underline" onClick={() => onChange({ column: col.key, op: 'in' })}>
          Select all
        </button>
        <button type="button" className="text-primary hover:underline" onClick={() => onChange({ column: col.key, op: 'in', values: [] })}>
          Clear
        </button>
      </div>
      <div className="max-h-60 space-y-0.5 overflow-y-auto thin-scroll" role="group" aria-label={`${col.label} values`}>
        {list.map((a) => (
          <label key={key(a.value)} className="flex cursor-pointer items-center gap-2 rounded-[3px] px-1 py-1 text-xs hover:bg-accent/60">
            <Checkbox checked={selected.has(key(a.value))} onCheckedChange={() => toggle(a.value)} />
            <span className={cn('min-w-0 flex-1 truncate', a.value === null && 'italic text-muted-foreground')}>{a.label}</span>
            <span className="tabular-nums text-muted-foreground">{a.count.toLocaleString('en-IN')}</span>
          </label>
        ))}
        {!list.length && <p className="px-1 py-2 text-xs text-muted-foreground">No value matches “{q}”.</p>}
      </div>
      {all.length >= 500 && <p className="text-[11px] text-muted-foreground">The 500 most common values are listed.</p>}
    </div>
  );
}

function DateEditor({
  data, col, filter, onChange, onDone,
}: { data: DatasetData; col: ColumnSchema; filter: Filter; onChange: (f: Filter) => void; onDone: () => void }) {
  const span = useMemo(() => dateSpan(data, col.key), [data, col.key]);
  const presets = span ? datePresets(span) : [];
  const [from, setFrom] = useState(typeof filter.from === 'string' ? filter.from : '');
  const [to, setTo] = useState(typeof filter.to === 'string' ? filter.to : '');
  const set = (f: string | null, t: string | null) => {
    onChange({ column: col.key, op: 'between', from: f, to: t });
    onDone();
  };
  const current = (p: DatePreset) => filter.from === p.from && filter.to === p.to;

  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs font-medium">{col.label}</p>
        {span && (
          <p className="text-[11px] text-muted-foreground">
            This data runs from {fmtDate(span.min)} to {fmtDate(span.max)}.
          </p>
        )}
      </div>
      <div className="space-y-0.5">
        <button
          type="button"
          onClick={() => set(null, null)}
          className={cn('w-full rounded-[3px] px-2 py-1.5 text-left text-xs', filter.from == null && filter.to == null ? 'bg-accent font-medium' : 'hover:bg-accent/60')}
        >
          All dates
        </button>
        {presets.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => set(p.from, p.to)}
            className={cn('w-full rounded-[3px] px-2 py-1.5 text-left text-xs', current(p) ? 'bg-accent font-medium' : 'hover:bg-accent/60')}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 border-t pt-3">
        <label className="space-y-1 text-[11px] text-muted-foreground">
          From
          <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="h-8 text-xs" />
        </label>
        <label className="space-y-1 text-[11px] text-muted-foreground">
          To
          <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="h-8 text-xs" />
        </label>
      </div>
      <Button size="sm" className="w-full" disabled={(!from && !to) || (!!from && !!to && from > to)} onClick={() => set(from || null, to || null)}>
        Apply range
      </Button>
    </div>
  );
}

function RangeEditor({
  col, filter, onChange, onDone,
}: { col: ColumnSchema; filter: Filter; onChange: (f: Filter) => void; onDone: () => void }) {
  const [from, setFrom] = useState(filter.from == null ? '' : String(filter.from));
  const [to, setTo] = useState(filter.to == null ? '' : String(filter.to));
  const lo = from === '' ? null : Number(from);
  const hi = to === '' ? null : Number(to);
  const bad = (lo !== null && !Number.isFinite(lo)) || (hi !== null && !Number.isFinite(hi)) || (lo !== null && hi !== null && lo > hi);
  const p = col.profile;

  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs font-medium">{col.label}</p>
        {typeof p?.min === 'number' && typeof p?.max === 'number' && (
          <p className="text-[11px] text-muted-foreground">
            Values run from {p.min.toLocaleString('en-IN')} to {p.max.toLocaleString('en-IN')}. Rows with no value are left out.
          </p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1 text-[11px] text-muted-foreground">
          At least
          <Input type="number" inputMode="decimal" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 text-xs" />
        </label>
        <label className="space-y-1 text-[11px] text-muted-foreground">
          At most
          <Input type="number" inputMode="decimal" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 text-xs" />
        </label>
      </div>
      {lo !== null && hi !== null && lo > hi && <p className="text-[11px] text-destructive">The lower bound is above the upper one.</p>}
      <Button
        size="sm"
        className="w-full"
        disabled={bad}
        onClick={() => {
          onChange({ column: col.key, op: 'between', from: lo, to: hi });
          onDone();
        }}
      >
        Apply
      </Button>
    </div>
  );
}
