'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Entity picker, modelled on the Zoho Books customer/item selector.
//
// Fixes the two things a plain <Select> gets wrong for finance data:
//   1. No search — these lists run to hundreds of customers, vendors and items.
//   2. One line of text — you need the secondary line (GSTIN, SKU, state, code)
//      to tell "Sharma Traders" apart from "Sharma Traders (Salem)".
//
// It also carries the "+ New …" footer action so a user who can't find the
// record never has to abandon the form to create it.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';
import { Check, ChevronDown, Plus, Search, X } from 'lucide-react';
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { cn } from '@/lib/utils';

export interface ComboboxOption {
  value: string;
  label: string;
  /** Second line — GSTIN, SKU, account code, state. */
  sublabel?: string;
  /** Right-aligned hint — price, balance, badge text. */
  meta?: string;
  /** Circle initials colour; falls back to a neutral chip. */
  avatarColor?: string;
  disabled?: boolean;
  group?: string;
}

function initials(label: string): string {
  return label
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

export function Combobox({
  options,
  value,
  onChange,
  placeholder = 'Select or add…',
  searchPlaceholder = 'Search',
  emptyMessage = 'No matches found',
  createLabel,
  onCreate,
  showAvatar = true,
  clearable = false,
  disabled = false,
  invalid = false,
  matchMode = 'contains',
  className,
  contentClassName,
  id,
}: {
  options: ComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  createLabel?: string;
  onCreate?: (query: string) => void;
  showAvatar?: boolean;
  clearable?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  /**
   * 'prefix' anchors the label match to the start of the string — typing "1"
   * lists 1001, 1005… but not 4011. Codes are searched that way (chapter first,
   * then narrower); names are not. The description still matches anywhere, so
   * you can find a code by what it is as well as by what it starts with.
   */
  matchMode?: 'contains' | 'prefix';
  className?: string;
  contentClassName?: string;
  id?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.value === value);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    if (matchMode === 'prefix') {
      // Codes anchor to the start; the description still matches anywhere. The
      // meta column is deliberately NOT searched — it holds the tax rate, and
      // "18%" would otherwise make every rated code a match for the digit 1.
      return options.filter(
        (o) => o.label.toLowerCase().startsWith(q) || o.sublabel?.toLowerCase().includes(q),
      );
    }
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.sublabel?.toLowerCase().includes(q) ||
        o.meta?.toLowerCase().includes(q),
    );
  }, [options, query, matchMode]);

  // Group headings, preserving the order groups first appear in.
  const grouped = React.useMemo(() => {
    const map = new Map<string, ComboboxOption[]>();
    for (const o of filtered) {
      const key = o.group ?? '';
      map.set(key, [...(map.get(key) ?? []), o]);
    }
    return [...map.entries()];
  }, [filtered]);

  React.useEffect(() => {
    if (open) {
      setQuery('');
      setActive(Math.max(0, filtered.findIndex((o) => o.value === value)));
      // Base UI moves focus to the popup; hand it to the search box.
      const t = setTimeout(() => inputRef.current?.focus(), 20);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  React.useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, query]);

  const commit = (opt: ComboboxOption) => {
    if (opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[active]) commit(filtered[active]);
      else if (onCreate && query.trim()) {
        onCreate(query.trim());
        setOpen(false);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        id={id}
        data-slot="combobox-trigger"
        disabled={disabled}
        nativeButton
        className={cn(
          'flex h-9 w-full items-center gap-2 rounded-md border bg-surface px-2.5 text-left text-sm transition-colors',
          'hover:border-primary/50 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 focus-visible:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-60',
          invalid ? 'border-destructive' : 'border-input',
          open && 'border-ring ring-2 ring-ring/25',
          className,
        )}
      >
        {selected ? (
          <>
            {showAvatar && (
              <span
                className="flex size-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white"
                style={{ backgroundColor: selected.avatarColor ?? 'var(--primary)' }}
              >
                {initials(selected.label)}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">{selected.label}</span>
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{placeholder}</span>
        )}

        {clearable && selected && !disabled && (
          <span
            role="button"
            tabIndex={-1}
            aria-label="Clear selection"
            onClick={(e) => {
              e.stopPropagation();
              onChange('');
            }}
            className="grid size-4 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-3" />
          </span>
        )}
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      </PopoverPrimitive.Trigger>

      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner side="bottom" align="start" sideOffset={4} className="isolate z-50">
          <PopoverPrimitive.Popup
            className={cn(
              'z-50 w-(--anchor-width) min-w-[300px] overflow-hidden rounded-md border bg-popover text-sm shadow-lg outline-none',
              'data-open:animate-in data-open:fade-in-0 data-open:zoom-in-98 data-closed:animate-out data-closed:fade-out-0',
              contentClassName,
            )}
          >
            {/* Search */}
            <div className="border-b p-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                  }}
                  onKeyDown={onKeyDown}
                  placeholder={searchPlaceholder}
                  className="h-8 w-full rounded border border-input bg-surface pl-8 pr-2 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/25"
                />
              </div>
            </div>

            {/* Options */}
            <div ref={listRef} className="thin-scroll max-h-[264px] overflow-y-auto py-1">
              {filtered.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">{emptyMessage}</p>
              ) : (
                grouped.map(([group, opts]) => (
                  <div key={group || '_'}>
                    {group && (
                      <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {group}
                      </p>
                    )}
                    {opts.map((o) => {
                      const idx = filtered.indexOf(o);
                      const isActive = idx === active;
                      const isSelected = o.value === value;
                      return (
                        <div
                          key={o.value}
                          role="option"
                          aria-selected={isSelected}
                          data-active={isActive}
                          onMouseEnter={() => setActive(idx)}
                          onClick={() => commit(o)}
                          className={cn(
                            'flex cursor-pointer items-center gap-2.5 px-3 py-1.5',
                            isActive && 'bg-primary text-primary-foreground',
                            o.disabled && 'cursor-not-allowed opacity-50',
                          )}
                        >
                          {showAvatar && (
                            <span
                              className={cn(
                                'flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold',
                                isActive ? 'bg-white/20 text-white' : 'text-white',
                              )}
                              style={
                                isActive
                                  ? undefined
                                  : { backgroundColor: o.avatarColor ?? 'var(--muted-foreground)' }
                              }
                            >
                              {initials(o.label)}
                            </span>
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium">{o.label}</p>
                            {o.sublabel && (
                              <p
                                className={cn(
                                  'truncate text-xs',
                                  isActive ? 'text-primary-foreground/75' : 'text-muted-foreground',
                                )}
                              >
                                {o.sublabel}
                              </p>
                            )}
                          </div>
                          {o.meta && (
                            <span
                              className={cn(
                                'shrink-0 text-xs tabular',
                                isActive ? 'text-primary-foreground/85' : 'text-muted-foreground',
                              )}
                            >
                              {o.meta}
                            </span>
                          )}
                          {isSelected && !isActive && <Check className="size-3.5 shrink-0 text-primary" />}
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>

            {/* Create action */}
            {onCreate && (
              <button
                type="button"
                onClick={() => {
                  onCreate(query.trim());
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 border-t px-3 py-2.5 text-left text-sm font-medium text-primary hover:bg-accent"
              >
                <Plus className="size-3.5" />
                {createLabel ?? 'New record'}
                {query.trim() && <span className="truncate text-muted-foreground">— “{query.trim()}”</span>}
              </button>
            )}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
