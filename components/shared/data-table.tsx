'use client';

// Lightweight sortable/filterable table used by every list screen.
// Deliberately dependency-free so the demo stays fast and predictable.
//
// It looks and behaves as Zoho Books' lists do (measured from Zoho's demo):
// - headings 11px uppercase grey on #f9f9fb, rows with #ebeaf2 hairlines and
//   #f1f1fa under the pointer, the record's name in Zoho's link blue;
// - the page's own list (not one inside a card, a tab or a dialog) runs edge to
//   edge, hands its search to the top bar ("Search in Invoices ( / )") and
//   puts its status views in the page title as Zoho's view menu
//   ("All Invoices" with a caret); see components/layout/page-context.ts.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, ChevronDown, Search, SlidersHorizontal, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { DateRangePicker } from '@/components/shared/date-range-picker';
import { ALL_TIME, describeRange, fromPreset, withinRange, type RangeValue } from '@/lib/date-range';
import { today } from '@/lib/selectors';
import { cn } from '@/lib/utils';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  claimListSearch, releaseListSearch, useHoldsListSearch, usePageTitle, useViewSlot,
} from '@/components/layout/page-context';

/** Zoho's view title: "All Invoices", "Unpaid Invoices", "Active Customers". */
export function viewTitle(label: string, title: string | null): string {
  if (!title) return label;
  if (/^all$/i.test(label)) return `All ${title}`;
  const noun = title.toLowerCase().replace(/s$/, '');
  if (label.toLowerCase().includes(noun)) return label;
  return `${label.replace(/^Drafts$/i, 'Draft')} ${title}`;
}

/** The status views as Zoho's title menu. */
function ViewPicker({ tabs, active, onChange }: { tabs: TableTab[]; active: string; onChange?: (v: string) => void }) {
  const title = usePageTitle();
  const current = tabs.find((t) => t.value === active) ?? tabs[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-slot="view-picker"
        className="flex min-w-0 items-center gap-1.5 rounded text-left text-[18px] font-semibold leading-snug outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
      >
        <span className="truncate">{viewTitle(current.label, title)}</span>
        <ChevronDown className="size-4 shrink-0 text-primary" strokeWidth={2.5} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {tabs.map((t) => (
          <DropdownMenuItem
            key={t.value}
            data-slot="table-tab"
            data-tab={t.value}
            data-active={t.value === current.value ? '1' : undefined}
            onClick={() => onChange?.(t.value)}
            className={cn('justify-between', t.value === current.value && 'font-medium')}
          >
            <span className="truncate">{t.label}</span>
            {t.count != null && <span className="shrink-0 text-[11px] tabular opacity-70">{t.count}</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface DateFilterConfig<T> {
  /** Pulls the date off a row. Supplying this is what turns the filter on. */
  getDate: (row: T) => string;
  /** Preset key to open on. Lists default to every date; reports do not. */
  initial?: 'all' | string;
  /** Controlled value — pass both when the page needs the range for its own counts. */
  value?: RangeValue;
  onChange?: (v: RangeValue) => void;
  label?: string;
}

export interface TableTab {
  value: string;
  label: string;
  count?: number;
}

export interface Column<T> {
  key: string;
  header: string;
  /** Cell renderer. */
  cell: (row: T) => ReactNode;
  /** Value used for sorting/searching (string or number). */
  sortValue?: (row: T) => string | number;
  align?: 'left' | 'right' | 'center';
  className?: string;
  headerClassName?: string;
  /**
   * The record's name, set in Zoho's link blue on a list whose rows open.
   * Left unset, the first column that is not a date is taken.
   */
  primary?: boolean;
  /** Off until switched on under Customize Columns (Zoho's defaults first, the rest one click away). */
  defaultHidden?: boolean;
}

/** Zoho's "Customize Columns": the sliders at the head of a list. */
function ColumnsMenu<T>({ columns, hidden, onToggle }: { columns: Column<T>[]; hidden: Set<string>; onToggle: (key: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Customize columns" title="Customize columns" className="grid size-5 place-items-center rounded text-primary hover:bg-primary/10" data-slot="columns-menu">
        <SlidersHorizontal className="size-3.5" strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel className="text-[11px] font-semibold uppercase text-muted-foreground">Customize Columns</DropdownMenuLabel>
        {columns.map((c, i) => (
          <DropdownMenuCheckboxItem
            key={c.key}
            checked={!hidden.has(c.key)}
            disabled={i === 0}
            closeOnClick={false}
            onCheckedChange={() => onToggle(c.key)}
            className="text-[13px] capitalize"
          >
            {c.header.toLowerCase() || c.key}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function DataTable<T>({
  rows,
  columns,
  getRowId,
  onRowClick,
  searchPlaceholder = 'Search…',
  searchable = true,
  emptyMessage = 'Nothing to show yet.',
  toolbar,
  footer,
  initialSort,
  dense = false,
  tabs,
  activeTab,
  onTabChange,
  selectable = false,
  bulkActions,
  dateFilter,
  columnsKey,
}: {
  rows: T[];
  columns: Column<T>[];
  getRowId: (row: T) => string;
  onRowClick?: (row: T) => void;
  searchPlaceholder?: string;
  searchable?: boolean;
  emptyMessage?: string;
  toolbar?: ReactNode;
  footer?: ReactNode;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  dense?: boolean;
  /** Zoho-style status tabs above the table. */
  tabs?: TableTab[];
  activeTab?: string;
  onTabChange?: (value: string) => void;
  /** Adds a checkbox column and a bulk action bar when rows are selected. */
  selectable?: boolean;
  bulkActions?: (selected: T[], clear: () => void) => ReactNode;
  /** Adds the shared date picker to the toolbar and filters rows by it. */
  dateFilter?: DateFilterConfig<T>;
  /** Where this list's chosen columns are remembered; by default its page title and columns. */
  columnsKey?: string;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Uncontrolled fallback. When the page passes value/onChange it owns the
  // range instead, so its tab counts and this table agree on the period.
  const [ownRange, setOwnRange] = useState<RangeValue>(() =>
    !dateFilter || (dateFilter.initial ?? 'all') === 'all'
      ? { ...ALL_TIME, mode: 'all' }
      : fromPreset(dateFilter.initial as string, today()),
  );
  const range = dateFilter?.value ?? ownRange;
  const setRange = dateFilter?.onChange ?? setOwnRange;
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(initialSort ?? null);

  // Is this the page's own list? Then it runs edge to edge and its search and
  // views move up into the top bar and the title, as Zoho's do.
  const rootRef = useRef<HTMLDivElement>(null);
  const owner = useRef(Symbol('list')).current;
  const [pageLevel, setPageLevel] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const inside = el.closest('[data-slot=card], [data-slot=tabs-content], [role=dialog], [data-slot=sheet-content], [data-slot=split-list], [data-slot=split-record], [data-slot=report-shell]');
    setPageLevel(!!el.closest('.app-page') && !inside);
  }, []);
  useEffect(() => {
    if (pageLevel && searchable) claimListSearch(owner, query, setQuery);
  }, [pageLevel, searchable, query, owner]);
  useEffect(() => () => releaseListSearch(owner), [owner]);
  const holdsSearch = useHoldsListSearch(owner);
  const viewSlot = useViewSlot();
  const viewsInTitle = pageLevel && !!viewSlot && !!tabs && tabs.length > 0;
  const primaryKey = columns.find((c) => c.primary)?.key
    ?? columns.find((c) => !/date|due/i.test(c.key) && !/date/i.test(c.header))?.key;

  // Customize Columns, remembered in this browser as Zoho remembers it.
  const pageTitle = usePageTitle();
  const storageKey = `rekonza.columns.${columnsKey ?? `${pageTitle ?? ''}:${columns.map((c) => c.key).join(',')}`}`;
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(columns.filter((c) => c.defaultHidden).map((c) => c.key)));
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) setHidden(new Set(JSON.parse(raw) as string[]));
    } catch { /* storage may be unavailable: Zoho's defaults stand */ }
  }, [storageKey]);
  const toggleColumn = (key: string) => setHidden((h) => {
    const next = new Set(h);
    if (next.has(key)) next.delete(key); else next.add(key);
    try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* this visit only */ }
    return next;
  });
  const shown = columns.filter((c) => !hidden.has(c.key));
  const lead = pageLevel || selectable;

  const searchText = (row: T) =>
    columns
      .map((c) => (c.sortValue ? String(c.sortValue(row)) : ''))
      .join(' ')
      .toLowerCase();

  const filtered = useMemo(() => {
    let out = rows;
    // Date first: it is the cheapest filter and usually the most selective.
    // Skipped when the page is already filtering by a range it controls.
    if (dateFilter && !dateFilter.value && range.mode !== 'all') {
      out = out.filter((r) => withinRange(dateFilter.getDate(r), range));
    }
    if (query.trim()) {
      const q = query.toLowerCase();
      out = out.filter((r) => searchText(r).includes(q));
    }
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col?.sortValue) {
        out = [...out].sort((a, b) => {
          const va = col.sortValue!(a);
          const vb = col.sortValue!(b);
          const cmp = typeof va === 'number' && typeof vb === 'number'
            ? va - vb
            : String(va).localeCompare(String(vb));
          return sort.dir === 'asc' ? cmp : -cmp;
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, query, sort, columns, range, dateFilter]);

  // Selecting rows then changing the filter would act on invisible records.
  useEffect(() => setSelected(new Set()), [activeTab, query, range]);

  const visibleIds = filtered.map(getRowId);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const selectedRows = filtered.filter((r) => selected.has(getRowId(r)));
  const clearSelection = () => setSelected(new Set());

  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(visibleIds));

  const toggleOne = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleSort = (key: string) => {
    setSort((s) =>
      s?.key === key
        ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' },
    );
  };

  return (
    <div ref={rootRef} className="space-y-3" data-slot="data-table" data-bleed={pageLevel ? '' : undefined}>
      {viewsInTitle && createPortal(
        <ViewPicker tabs={tabs!} active={activeTab ?? tabs![0].value} onChange={onTabChange} />,
        viewSlot!,
      )}
      {tabs && tabs.length > 0 && !viewsInTitle && (
        <div className="flex flex-wrap items-center gap-x-6 border-b no-print">
          {tabs.map((t) => {
            const isActive = (activeTab ?? tabs[0].value) === t.value;
            return (
              <button
                key={t.value}
                type="button"
                data-slot="table-tab"
                data-tab={t.value}
                onClick={() => onTabChange?.(t.value)}
                className={cn(
                  '-mb-px flex items-center gap-1.5 border-b-2 pb-2.5 pt-2 text-[13px] transition-colors',
                  isActive
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-foreground/70 hover:text-foreground',
                )}
              >
                {t.label}
                {t.count != null && (
                  <span
                    className={cn(
                      'rounded-full px-1.5 py-px text-[10px] tabular',
                      isActive ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {t.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {selectable && selectedRows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-table-head px-3 py-2 no-print" data-slot="bulk-bar">
          <span className="text-[13px] font-medium">
            {selectedRows.length} selected
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {bulkActions?.(selectedRows, clearSelection)}
          </div>
          <Button variant="ghost" size="xs" onClick={clearSelection} className="ml-auto gap-1">
            <X className="size-3" /> Clear
          </Button>
        </div>
      )}

      {((searchable && !holdsSearch) || toolbar || dateFilter) && (
        <div className="flex flex-wrap items-center gap-2 no-print">
          {searchable && !holdsSearch && (
            <div className="relative w-full max-w-xs">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                className="pl-8"
              />
            </div>
          )}
          {dateFilter && (
            <DateRangePicker
              value={range}
              onChange={setRange}
              allowAll
              align="start"
              dataDates={rows.map(dateFilter.getDate)}
            />
          )}
          {toolbar}
          {range.mode !== 'all' && (
            <span className="text-xs text-muted-foreground">
              {filtered.length} of {rows.length} in this period
            </span>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-md border thin-scroll" data-slot="data-table-grid">
        <Table>
          <TableHeader>
            <TableRow className="bg-table-head hover:bg-table-head">
              {lead && (
                <TableHead className={cn(pageLevel ? 'w-[68px]' : 'w-10')}>
                  <span className="flex items-center gap-3">
                    {pageLevel && <ColumnsMenu columns={columns} hidden={hidden} onToggle={toggleColumn} />}
                    {selectable && (
                      <Checkbox
                        aria-label="Select all"
                        checked={allSelected}
                        onCheckedChange={toggleAll}
                      />
                    )}
                  </span>
                </TableHead>
              )}
              {shown.map((c) => (
                <TableHead
                  key={c.key}
                  className={cn(
                    'group/th whitespace-nowrap',
                    c.align === 'right' && 'text-right',
                    c.align === 'center' && 'text-center',
                    c.sortValue && 'cursor-pointer select-none',
                    c.headerClassName,
                  )}
                  onClick={c.sortValue ? () => toggleSort(c.key) : undefined}
                >
                  <span className={cn('inline-flex items-center gap-1', c.align === 'right' && 'flex-row-reverse')}>
                    {c.header}
                    {/* Zoho marks only the column the list is sorted by. */}
                    {c.sortValue &&
                      (sort?.key === c.key ? (
                        sort.dir === 'asc' ? <ArrowUp className="size-3 text-primary" /> : <ArrowDown className="size-3 text-primary" />
                      ) : (
                        <ArrowDown className="size-3 opacity-0 transition-opacity group-hover/th:opacity-40" />
                      ))}
                  </span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={shown.length + (lead ? 1 : 0)} className="h-28 text-center text-sm text-muted-foreground">
                  {/* Say which filter is hiding things, or the table looks broken. */}
                  {range.mode !== 'all' ? (
                    <span className="space-y-2">
                      <span className="block">Nothing in {describeRange(range).toLowerCase()}.</span>
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => setRange({ ...ALL_TIME, mode: 'all' })}
                      >
                        Show all dates
                      </Button>
                    </span>
                  ) : (
                    emptyMessage
                  )}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((row) => (
                <TableRow
                  key={getRowId(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    onRowClick && 'cursor-pointer',
                    dense && '[&>td]:py-1.5',
                    selected.has(getRowId(row)) && 'bg-row-hover',
                  )}
                >
                  {lead && (
                    <TableCell className={cn(pageLevel ? 'w-[68px] first:pl-[52px]' : 'w-10')} onClick={selectable ? (e) => e.stopPropagation() : undefined}>
                      {selectable && (
                        <Checkbox
                          aria-label="Select row"
                          checked={selected.has(getRowId(row))}
                          onCheckedChange={() => toggleOne(getRowId(row))}
                        />
                      )}
                    </TableCell>
                  )}
                  {shown.map((c) => (
                    <TableCell
                      key={c.key}
                      className={cn(
                        'whitespace-nowrap',
                        c.align === 'right' && 'text-right',
                        c.align === 'center' && 'text-center',
                        // The record's name in Zoho's link blue, on a list whose rows open.
                        onRowClick && c.key === primaryKey && 'font-medium text-link',
                        c.className,
                      )}
                    >
                      {c.cell(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {footer}
      {filtered.length > 0 && (
        <p className="text-xs text-muted-foreground no-print">
          {filtered.length} of {rows.length} record{rows.length === 1 ? '' : 's'}
        </p>
      )}
    </div>
  );
}
