'use client';

// ─────────────────────────────────────────────────────────────────────────────
// One date filter for the whole app.
//
// Two bare date inputs are technically capable of expressing any range, and in
// practice nobody uses them: picking "August 2026" meant typing 01/08/2026 and
// 31/08/2026 and knowing August has 31 days. Every real request — a day, a
// month, a quarter, a financial year — is one click here, and the free range is
// still there for the cases that are genuinely irregular.
//
// The tabs are ordered by how often they get used, not by how long the period
// is: month first, because month-end is when most of this work happens.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Check, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAppStore } from '@/lib/store';
import { today as demoToday } from '@/lib/selectors';
import {
  ALL_TIME, FY_QUARTERS, PRESETS, availableFys, describeRange, fyLabel, fyMonths,
  fyOf, fyRange, monthRange, quarterRange, type RangeValue,
} from '@/lib/date-range';
import { cn } from '@/lib/utils';

type TabKey = 'quick' | 'month' | 'quarter' | 'fy' | 'day' | 'custom';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'quick', label: 'Quick ranges' },
  { key: 'month', label: 'Month' },
  { key: 'quarter', label: 'Quarter' },
  { key: 'fy', label: 'Financial year' },
  { key: 'day', label: 'Single day' },
  { key: 'custom', label: 'Custom range' },
];

/** The tab that should be showing when the picker reopens on an existing value. */
function tabFor(v: RangeValue): TabKey {
  switch (v.mode) {
    case 'month':
      return 'month';
    case 'quarter':
      return 'quarter';
    case 'fy':
      return 'fy';
    case 'day':
      return 'day';
    case 'custom':
      return 'custom';
    default:
      return 'quick';
  }
}

export function DateRangePicker({
  value,
  onChange,
  /** Adds an "All dates" option — right for lists, wrong for reports that must state a period. */
  allowAll = false,
  /** Dates in the data, used to decide which financial years are worth offering. */
  dataDates,
  align = 'end',
  className,
  label,
}: {
  value: RangeValue;
  onChange: (v: RangeValue) => void;
  allowAll?: boolean;
  dataDates?: string[];
  align?: 'start' | 'center' | 'end';
  className?: string;
  label?: string;
}) {
  const orgFyStart = useAppStore((s) => s.org?.fiscalYearStart);
  const today = demoToday();
  const currentFy = fyOf(today);

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<TabKey>(() => tabFor(value));

  // Reopening should land on the tab that produced the current value, not on
  // whichever tab was left showing when it was last closed.
  useEffect(() => {
    if (open) setTab(tabFor(value));
  }, [open, value]);

  const fys = useMemo(
    () => availableFys(dataDates ?? [orgFyStart ?? today], today),
    [dataDates, orgFyStart, today],
  );
  const oldestFy = fys[fys.length - 1] ?? currentFy;

  // Which FY the month and quarter grids are showing. Independent of the
  // selection, so you can browse back a year without committing to anything.
  const [browseFy, setBrowseFy] = useState(currentFy);
  useEffect(() => {
    if (!open) return;
    // "All dates" carries a sentinel from-date of 1900, which is not a year
    // anybody wants to browse. Anything outside the years the books cover
    // falls back to the current one.
    const derived =
      value.mode === 'all'
        ? currentFy
        : value.key?.includes(':')
          ? Number(value.key.split(':')[0])
          : fyOf(value.from);
    setBrowseFy(derived >= oldestFy && derived <= currentFy ? derived : currentFy);
  }, [open, value, currentFy, oldestFy]);

  const [draft, setDraft] = useState({ from: value.from, to: value.to });
  useEffect(() => {
    if (open) setDraft({ from: value.from, to: value.to });
  }, [open, value]);

  const commit = (v: RangeValue) => {
    onChange(v);
    setOpen(false);
  };

  const isActive = (mode: RangeValue['mode'], key?: string) =>
    value.mode === mode && value.key === key;

  const months = fyMonths(browseFy);
  // A month that has not started yet cannot have transactions in it.
  const isFuture = (from: string) => from > today;

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {label && <span className="text-[11px] font-medium text-muted-foreground">{label}</span>}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          data-slot="date-range-trigger"
          className={cn(
            'flex h-9 min-w-[13rem] items-center gap-2 rounded-[3px] border border-input bg-surface px-3 text-sm',
            'transition-colors outline-none hover:bg-accent/40',
            'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25',
            'data-[popup-open]:border-ring data-[popup-open]:ring-2 data-[popup-open]:ring-ring/25',
          )}
        >
          <CalendarDays className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate text-left">{describeRange(value)}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </PopoverTrigger>

        <PopoverContent
          align={align}
          className="w-[min(38rem,calc(100vw-2rem))] gap-0 p-0"
          data-slot="date-range-panel"
        >
          <div className="flex flex-col sm:flex-row">
            {/* Tab rail — horizontal on phones, vertical from sm up */}
            <div className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 thin-scroll sm:w-40 sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  data-slot="date-tab"
                  data-tab={t.key}
                  onClick={() => setTab(t.key)}
                  className={cn(
                    'shrink-0 rounded-[3px] px-2.5 py-1.5 text-left text-xs font-medium transition-colors sm:w-full',
                    tab === t.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  {t.label}
                </button>
              ))}
              {allowAll && (
                <button
                  type="button"
                  data-slot="date-tab"
                  data-tab="all"
                  onClick={() => commit({ ...ALL_TIME, mode: 'all' })}
                  className={cn(
                    'shrink-0 rounded-[3px] px-2.5 py-1.5 text-left text-xs font-medium transition-colors sm:mt-auto sm:w-full',
                    value.mode === 'all' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  All dates
                </button>
              )}
            </div>

            <div className="min-w-0 flex-1 p-3">
              {/* ── Quick ranges ─────────────────────────────────────────── */}
              {tab === 'quick' && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {(['Current', 'Previous'] as const).map((group) => (
                    <div key={group}>
                      <p className="micro-label mb-1.5">{group}</p>
                      <div className="space-y-0.5">
                        {PRESETS.filter((p) => p.group === group).map((p) => (
                          <button
                            key={p.key}
                            type="button"
                            data-slot="date-preset"
                            onClick={() => commit({ ...p.resolve(today), mode: 'preset', key: p.key })}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-[3px] px-2 py-1.5 text-left text-xs transition-colors',
                              isActive('preset', p.key) ? 'bg-accent font-medium' : 'hover:bg-accent/60',
                            )}
                          >
                            <span className="flex-1 truncate">{p.label}</span>
                            {isActive('preset', p.key) && <Check className="size-3.5 shrink-0 text-primary" />}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* ── Month ────────────────────────────────────────────────── */}
              {tab === 'month' && (
                <div>
                  <FyStepper
                    fy={browseFy}
                    onChange={setBrowseFy}
                    min={oldestFy}
                    max={currentFy}
                  />
                  <div className="mt-3 grid grid-cols-3 gap-1.5 sm:grid-cols-4">
                    {months.map((m) => {
                      const r = monthRange(m.key);
                      const future = isFuture(r.from);
                      return (
                        <button
                          key={m.key}
                          type="button"
                          data-slot="date-month"
                          disabled={future}
                          onClick={() => commit({ ...r, mode: 'month', key: m.key })}
                          className={cn(
                            'rounded-[3px] border px-2 py-2 text-xs font-medium transition-colors',
                            'disabled:cursor-not-allowed disabled:border-dashed disabled:text-muted-foreground/40',
                            isActive('month', m.key)
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'hover:border-primary/40 hover:bg-accent',
                          )}
                        >
                          {m.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                    Months run in financial-year order, April first — the order your returns are filed in.
                  </p>
                </div>
              )}

              {/* ── Quarter ──────────────────────────────────────────────── */}
              {tab === 'quarter' && (
                <div>
                  <FyStepper
                    fy={browseFy}
                    onChange={setBrowseFy}
                    min={oldestFy}
                    max={currentFy}
                  />
                  <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
                    {FY_QUARTERS.map((q) => {
                      const r = quarterRange(browseFy, q.key);
                      const key = `${browseFy}:${q.key}`;
                      const future = isFuture(r.from);
                      return (
                        <button
                          key={q.key}
                          type="button"
                          data-slot="date-quarter"
                          disabled={future}
                          onClick={() => commit({ ...r, mode: 'quarter', key })}
                          className={cn(
                            'rounded-[3px] border px-3 py-2 text-left text-xs font-medium transition-colors',
                            'disabled:cursor-not-allowed disabled:border-dashed disabled:text-muted-foreground/40',
                            isActive('quarter', key)
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'hover:border-primary/40 hover:bg-accent',
                          )}
                        >
                          {q.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                    Quarters follow the financial year, so Q1 is April to June — not January to March.
                  </p>
                </div>
              )}

              {/* ── Financial year ───────────────────────────────────────── */}
              {tab === 'fy' && (
                <div>
                  <p className="micro-label mb-2">Financial years</p>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {fys.map((y) => (
                      <button
                        key={y}
                        type="button"
                        data-slot="date-fy"
                        onClick={() => commit({ ...fyRange(y), mode: 'fy', key: String(y) })}
                        className={cn(
                          'rounded-[3px] border px-3 py-2 text-left text-xs font-medium transition-colors',
                          isActive('fy', String(y))
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'hover:border-primary/40 hover:bg-accent',
                        )}
                      >
                        FY {fyLabel(y)}
                        <span className="ml-1.5 font-normal opacity-70">
                          {y === currentFy ? '· current' : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                  <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                    1 April to 31 March. Only years your books actually cover are offered.
                  </p>
                </div>
              )}

              {/* ── Single day ───────────────────────────────────────────── */}
              {tab === 'day' && (
                <div className="space-y-3">
                  <div>
                    <p className="micro-label mb-1.5">Pick a date</p>
                    <Input
                      type="date"
                      data-slot="date-single"
                      value={draft.from}
                      max={today}
                      onChange={(e) => setDraft({ from: e.target.value, to: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      { label: 'Today', d: today },
                      { label: 'Yesterday', d: PRESETS.find((p) => p.key === 'yesterday')!.resolve(today).from },
                    ].map((q) => (
                      <Button
                        key={q.label}
                        variant="outline"
                        size="xs"
                        onClick={() => setDraft({ from: q.d, to: q.d })}
                      >
                        {q.label}
                      </Button>
                    ))}
                  </div>
                  <Button
                    size="sm"
                    className="w-full"
                    disabled={!draft.from}
                    onClick={() => commit({ from: draft.from, to: draft.from, mode: 'day' })}
                  >
                    Show this day
                  </Button>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Sets both ends of the range to the same date, so you see exactly one day.
                  </p>
                </div>
              )}

              {/* ── Custom range ─────────────────────────────────────────── */}
              {tab === 'custom' && (
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <p className="micro-label mb-1.5">From</p>
                      <Input
                        type="date"
                        data-slot="date-from"
                        value={draft.from}
                        max={draft.to || undefined}
                        onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
                      />
                    </div>
                    <div>
                      <p className="micro-label mb-1.5">To</p>
                      <Input
                        type="date"
                        data-slot="date-to"
                        value={draft.to}
                        min={draft.from || undefined}
                        onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
                      />
                    </div>
                  </div>

                  {draft.from && draft.to && draft.from > draft.to && (
                    <p className="text-xs text-destructive">
                      The start date is after the end date. Swap them, or the range covers nothing.
                    </p>
                  )}

                  <Button
                    size="sm"
                    className="w-full"
                    disabled={!draft.from || !draft.to || draft.from > draft.to}
                    onClick={() => commit({ from: draft.from, to: draft.to, mode: 'custom' })}
                  >
                    Apply range
                  </Button>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Both dates are included. For anything that lines up with a month, quarter or year, the tabs
                    on the left are quicker and cannot be off by a day.
                  </p>
                </div>
              )}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** ‹ FY 2026-27 › — steps the month and quarter grids between years. */
function FyStepper({
  fy,
  onChange,
  min,
  max,
}: {
  fy: number;
  onChange: (y: number) => void;
  min: number;
  max: number;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Button
        variant="outline"
        size="xs"
        disabled={fy <= min}
        onClick={() => onChange(fy - 1)}
        aria-label="Previous financial year"
      >
        ‹
      </Button>
      <span className="text-xs font-medium">FY {fyLabel(fy)}</span>
      <Button
        variant="outline"
        size="xs"
        disabled={fy >= max}
        onClick={() => onChange(fy + 1)}
        aria-label="Next financial year"
      >
        ›
      </Button>
    </div>
  );
}
