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
// - the view menu has Zoho's search box, its "DEFAULT FILTERS" heading and a
//   star on each view that keeps it under "FAVORITES";
// - the icon at the head of the first column opens Customize Columns and Wrap
//   Text, and a column is widened or narrowed by dragging its edge (Reset
//   Column Width, in the page's ⋯, puts them back: resetColumnWidths()).
//   Only the columns Zoho sorts by sort (Column.sortable).

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, ChevronDown, Plus, Search, SlidersHorizontal, Star, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { CustomViewDialog } from '@/components/shared/custom-view-dialog';
import { AdvancedSearchDialog, type AdvancedSearchConfig } from '@/components/shared/advanced-search';
import { api } from '@/lib/api/client';
import { applyView, type CustomView, type ViewField } from '@/lib/custom-views';
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
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
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

/** Reset every list's column widths on this page (Zoho's "Reset Column Width"). */
export function resetColumnWidths() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('rekonza:reset-columns'));
}

/** A view kept under FAVORITES in the view menu, per list, in this browser. */
function useFavouriteViews(title: string | null) {
  const key = `rekonza.views.favourites.${title ?? ''}`;
  const [fav, setFav] = useState<string[]>([]);
  useEffect(() => {
    try { setFav(JSON.parse(localStorage.getItem(key) || '[]')); } catch { setFav([]); }
  }, [key]);
  const toggle = (v: string) => setFav((f) => {
    const next = f.includes(v) ? f.filter((x) => x !== v) : [...f, v];
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* this visit only */ }
    return next;
  });
  return { fav, toggle };
}

/** A saved custom view, as the menu lists it. */
interface SavedCustom { id: string; name: string; mine: boolean; shared: boolean; filters: CustomView & { kind?: string; favourite?: boolean } }

/** The status views as Zoho's title menu: a search box, FAVORITES, DEFAULT FILTERS, CREATED BY ME, a star on each, and "New View". */
function ViewPicker({ tabs, active, onChange, custom }: {
  tabs: TableTab[]; active: string; onChange?: (v: string) => void;
  custom?: { views: SavedCustom[]; activeId: string | null; onPick: (id: string) => void; onNew: () => void; onDelete: (v: SavedCustom) => void };
}) {
  const title = usePageTitle();
  const current = tabs.find((t) => t.value === active) ?? tabs[0];
  const activeCustom = custom?.views.find((v) => v.id === custom.activeId) ?? null;
  const [q, setQ] = useState('');
  const { fav, toggle } = useFavouriteViews(title);
  const match = (t: TableTab) => !q.trim() || t.label.toLowerCase().includes(q.trim().toLowerCase());
  const item = (t: TableTab) => (
    <DropdownMenuItem
      key={t.value}
      data-slot="table-tab"
      data-tab={t.value}
      data-active={t.value === current.value ? '1' : undefined}
      onClick={() => onChange?.(t.value)}
      className={cn('group/view justify-between gap-2', t.value === current.value && 'font-medium')}
    >
      <span className="truncate">{t.label}</span>
      <span className="flex shrink-0 items-center gap-2">
        {t.count != null && <span className="text-[11px] tabular opacity-70">{t.count}</span>}
        <span
          role="button"
          tabIndex={-1}
          aria-label={fav.includes(t.value) ? `Remove ${t.label} from favourites` : `Add ${t.label} to favourites`}
          data-slot="view-star"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggle(t.value); }}
          className={cn('grid size-5 place-items-center rounded hover:bg-muted', fav.includes(t.value) ? 'text-warning' : 'text-muted-foreground/60 opacity-0 group-hover/view:opacity-100')}
        >
          <Star className={cn('size-3.5', fav.includes(t.value) && 'fill-current')} />
        </span>
      </span>
    </DropdownMenuItem>
  );
  const favs = tabs.filter((t) => fav.includes(t.value) && match(t));
  const rest = tabs.filter(match);
  const customs = (custom?.views ?? []).filter((v) => match({ value: v.id, label: v.name }));
  const customItem = (v: SavedCustom) => (
    <DropdownMenuItem
      key={`custom:${v.id}`}
      data-slot="custom-view"
      data-view={v.id}
      onClick={() => custom?.onPick(v.id)}
      className={cn('group/view justify-between gap-2', v.id === custom?.activeId && 'font-medium')}
    >
      <span className="truncate">{v.name}</span>
      <span className="flex shrink-0 items-center gap-1">
        {v.mine && (
          <span role="button" tabIndex={-1} aria-label={`Delete the view ${v.name}`} data-slot="delete-view"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); custom?.onDelete(v); }}
            className="grid size-5 place-items-center rounded text-muted-foreground/70 opacity-0 hover:bg-muted group-hover/view:opacity-100">
            <Trash2 className="size-3.5" />
          </span>
        )}
        <span role="button" tabIndex={-1} aria-label={fav.includes(`custom:${v.id}`) ? `Remove ${v.name} from favourites` : `Add ${v.name} to favourites`}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggle(`custom:${v.id}`); }}
          className={cn('grid size-5 place-items-center rounded hover:bg-muted', fav.includes(`custom:${v.id}`) ? 'text-warning' : 'text-muted-foreground/60 opacity-0 group-hover/view:opacity-100')}>
          <Star className={cn('size-3.5', fav.includes(`custom:${v.id}`) && 'fill-current')} />
        </span>
      </span>
    </DropdownMenuItem>
  );
  const favCustoms = customs.filter((v) => fav.includes(`custom:${v.id}`));
  return (
    <DropdownMenu onOpenChange={(o) => { if (!o) setQ(''); }}>
      <DropdownMenuTrigger
        data-slot="view-picker"
        className="flex min-w-0 items-center gap-1.5 rounded text-left text-[18px] font-semibold leading-snug outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
      >
        <span className="truncate">{activeCustom ? activeCustom.name : current.title ?? viewTitle(current.label, title)}</span>
        <ChevronDown className="size-4 shrink-0 text-primary" strokeWidth={2.5} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {/* Letters typed here search the views; Escape, the arrows and Tab still drive the menu. */}
        <div className="p-1.5 pb-1" onKeyDown={(e) => { if (!['Escape', 'ArrowDown', 'ArrowUp', 'Tab'].includes(e.key)) e.stopPropagation(); }}>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search views" data-slot="view-search" className="h-8 pl-7 text-[13px]" />
          </div>
        </div>
        {favs.length + favCustoms.length > 0 && (
          <>
            <DropdownMenuLabel className="text-[11px] font-semibold uppercase text-muted-foreground" data-slot="view-favourites">Favorites</DropdownMenuLabel>
            {favs.map(item)}
            {favCustoms.map(customItem)}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel className="flex items-center gap-2 text-[11px] font-semibold uppercase text-muted-foreground">
          Default Filters
          <span className="rounded-full bg-primary px-1.5 text-[10px] font-medium text-primary-foreground tabular">{tabs.length}</span>
        </DropdownMenuLabel>
        {rest.length ? rest.map(item) : <p className="px-2 py-1.5 text-[12px] text-muted-foreground">No view matches.</p>}
        {custom && (
          <>
            <DropdownMenuLabel className="mt-1 flex items-center gap-2 text-[11px] font-semibold uppercase text-muted-foreground" data-slot="views-mine">
              Created by me
              <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground tabular">{custom.views.length}</span>
            </DropdownMenuLabel>
            {customs.map(customItem)}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={custom.onNew} data-slot="new-view-open" className="gap-2 text-link">
              <Plus className="size-3.5" /> New View
            </DropdownMenuItem>
          </>
        )}
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
  /** The heading the view gives the list, when "<label> <title>" would not read right (Zoho's "Services"). */
  title?: string;
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
  /** False where Zoho does not sort by the column; its value still feeds the search. */
  sortable?: boolean;
}

/** Zoho's sliders at the head of a list: Customize Columns, and Wrap Text. */
function ColumnsMenu<T>({ columns, hidden, onToggle, wrap, onWrap }: { columns: Column<T>[]; hidden: Set<string>; onToggle: (key: string) => void; wrap: boolean; onWrap: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Customize columns" title="Customize columns" className="grid size-5 place-items-center rounded text-primary hover:bg-primary/10" data-slot="columns-menu">
        <SlidersHorizontal className="size-3.5" strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuCheckboxItem checked={wrap} closeOnClick={false} onCheckedChange={onWrap} className="text-[13px]" data-slot="wrap-text">
          Wrap Text
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
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
  customViews,
  advancedSearch,
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
  /** Zoho's advanced search: the magnifier at the end of the header row, and its dialog. */
  advancedSearch?: AdvancedSearchConfig<T>;
  /** Where this list's chosen columns are remembered; by default its page title and columns. */
  columnsKey?: string;
  /**
   * Zoho's custom views ("New View"): the list's name in /api/saved-views,
   * the fields a criterion can test, and the view the rows come from (all of them).
   */
  customViews?: { list: string; fields: ViewField<T>[]; baseTab?: string };
}) {
  const [query, setQuery] = useState('');
  // The advanced search's criteria, and its dialog.
  const [criteria, setCriteria] = useState<Record<string, string>>({});
  const [searchOpen, setSearchOpen] = useState(false);
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
  const listShown = columns.filter((c) => !hidden.has(c.key));
  const lead = pageLevel || selectable;

  // Custom views: loaded for the list, one active at a time in place of a status view.
  const [savedViews, setSavedViews] = useState<SavedCustom[]>([]);
  const [activeCustomId, setActiveCustomId] = useState<string | null>(null);
  const [newViewOpen, setNewViewOpen] = useState(false);
  const loadViews = async () => {
    if (!customViews) return;
    try {
      const r = await api.get<{ views: SavedCustom[] }>('/api/saved-views', { list: customViews.list });
      setSavedViews(r.views.filter((v) => v.filters?.kind === 'custom'));
    } catch { /* no saved views: the status views stand */ }
  };
  useEffect(() => {
    void loadViews();
    // Read again only when the list changes; loadViews is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customViews?.list]);
  const activeCustom = savedViews.find((v) => v.id === activeCustomId) ?? null;
  // A custom view shows the columns it was saved with, in its order.
  const viewColumns = activeCustom?.filters.columns?.length
    ? activeCustom.filters.columns.map((k) => columns.find((c) => c.key === k)).filter((c): c is Column<T> => !!c)
    : [];
  const shown = viewColumns.length ? viewColumns : listShown;
  const pickCustom = (id: string) => {
    setActiveCustomId(id);
    if (customViews?.baseTab && activeTab !== customViews.baseTab) onTabChange?.(customViews.baseTab);
  };
  const deleteCustom = async (v: SavedCustom) => {
    if (!window.confirm(`Delete the view "${v.name}"?`)) return;
    try {
      await api.delete(`/api/saved-views?id=${encodeURIComponent(v.id)}`);
      if (activeCustomId === v.id) setActiveCustomId(null);
      toast.success(`View "${v.name}" deleted`);
      void loadViews();
    } catch (e) {
      toast.error('Not deleted', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  // Wrap Text and the widths dragged on each column, remembered with the columns.
  const [wrap, setWrap] = useState(false);
  const [widths, setWidths] = useState<Record<string, number>>({});
  useEffect(() => {
    try {
      setWrap(localStorage.getItem(`${storageKey}.wrap`) === '1');
      setWidths(JSON.parse(localStorage.getItem(`${storageKey}.widths`) || '{}'));
    } catch { /* defaults */ }
  }, [storageKey]);
  useEffect(() => {
    const reset = () => {
      setWidths({});
      try { localStorage.removeItem(`${storageKey}.widths`); } catch { /* nothing kept */ }
    };
    window.addEventListener('rekonza:reset-columns', reset);
    return () => window.removeEventListener('rekonza:reset-columns', reset);
  }, [storageKey]);
  const toggleWrap = () => setWrap((w) => {
    try { localStorage.setItem(`${storageKey}.wrap`, w ? '0' : '1'); } catch { /* this visit only */ }
    return !w;
  });
  /** Drag a heading's right edge to widen or narrow its column. */
  const startResize = (key: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).closest('th');
    const start = e.clientX;
    const from = th?.getBoundingClientRect().width ?? 120;
    let last = from;
    const move = (ev: MouseEvent) => {
      last = Math.max(60, Math.round(from + ev.clientX - start));
      setWidths((w) => ({ ...w, [key]: last }));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setWidths((w) => {
        const next = { ...w, [key]: last };
        try { localStorage.setItem(`${storageKey}.widths`, JSON.stringify(next)); } catch { /* this visit only */ }
        return next;
      });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const canSort = (c: Column<T>) => !!c.sortValue && c.sortable !== false;

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
    if (activeCustom && customViews) out = applyView(out, activeCustom.filters, customViews.fields);
    if (advancedSearch && Object.keys(criteria).length) {
      out = out.filter((r) => advancedSearch.fields.every((f) => !criteria[f.key] || f.match(r, criteria[f.key])));
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
  }, [rows, query, sort, columns, range, dateFilter, activeCustom, criteria, advancedSearch]);

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
        <ViewPicker
          tabs={tabs!}
          active={activeTab ?? tabs![0].value}
          onChange={(v) => { setActiveCustomId(null); onTabChange?.(v); }}
          custom={customViews ? { views: savedViews, activeId: activeCustomId, onPick: pickCustom, onNew: () => setNewViewOpen(true), onDelete: (v) => void deleteCustom(v) } : undefined}
        />,
        viewSlot!,
      )}
      {customViews && (
        <CustomViewDialog
          open={newViewOpen}
          onOpenChange={setNewViewOpen}
          list={customViews.list}
          fields={customViews.fields}
          columns={columns.map((c) => ({ key: c.key, header: c.header }))}
          onSaved={(id) => { void loadViews().then(() => pickCustom(id)); }}
        />
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

      {advancedSearch && Object.keys(criteria).length > 0 && (
        <div className="flex items-center gap-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-[13px]" data-slot="advanced-search-results">
          <span>Search results: {filtered.length} matching {Object.entries(criteria).map(([k, v]) => `${advancedSearch.fields.find((f) => f.key === k)?.label ?? k} "${advancedSearch.fields.find((f) => f.key === k)?.options?.find((o) => o.value === v)?.label ?? v}"`).join(', ')}</span>
          <button type="button" className="ml-auto text-link hover:underline" onClick={() => setSearchOpen(true)}>Change</button>
          <button type="button" className="text-link hover:underline" onClick={() => setCriteria({})} data-slot="advanced-search-clear">Clear Search</button>
        </div>
      )}
      {advancedSearch && (
        <AdvancedSearchDialog config={advancedSearch} view={activeCustom?.name ?? tabs?.find((x) => x.value === activeTab)?.title ?? `${tabs?.find((x) => x.value === activeTab)?.label ?? 'All'} ${advancedSearch.module}`}
          value={criteria} open={searchOpen} onOpenChange={setSearchOpen} onSearch={setCriteria} />
      )}
      <div className="overflow-x-auto rounded-md border thin-scroll" data-slot="data-table-grid">
        <Table>
          <TableHeader>
            <TableRow className="bg-table-head hover:bg-table-head">
              {lead && (
                <TableHead className={cn(pageLevel ? 'w-[68px]' : 'w-10')}>
                  <span className="flex items-center gap-3">
                    {pageLevel && <ColumnsMenu columns={columns} hidden={hidden} onToggle={toggleColumn} wrap={wrap} onWrap={toggleWrap} />}
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
                    'group/th relative whitespace-nowrap',
                    c.align === 'right' && 'text-right',
                    c.align === 'center' && 'text-center',
                    canSort(c) && 'cursor-pointer select-none',
                    c.headerClassName,
                  )}
                  style={widths[c.key] ? { width: widths[c.key], minWidth: widths[c.key], maxWidth: widths[c.key] } : undefined}
                  data-sortable={canSort(c) ? '1' : undefined}
                  onClick={canSort(c) ? () => toggleSort(c.key) : undefined}
                >
                  <span className={cn('inline-flex items-center gap-1', c.align === 'right' && 'flex-row-reverse')}>
                    {c.header}
                    {/* Zoho marks only the column the list is sorted by. */}
                    {canSort(c) &&
                      (sort?.key === c.key ? (
                        sort.dir === 'asc' ? <ArrowUp className="size-3 text-primary" /> : <ArrowDown className="size-3 text-primary" />
                      ) : (
                        <ArrowDown className="size-3 opacity-0 transition-opacity group-hover/th:opacity-40" />
                      ))}
                  </span>
                  {pageLevel && (
                    <span
                      aria-hidden
                      data-slot="column-resize"
                      onMouseDown={(e) => startResize(c.key, e)}
                      onClick={(e) => e.stopPropagation()}
                      className="absolute inset-y-1 right-0 w-1.5 cursor-col-resize rounded border-r-2 border-transparent hover:border-primary/50"
                    />
                  )}
                </TableHead>
              ))}
              {advancedSearch && (
                <TableHead className="w-10 text-right">
                  <button type="button" aria-label="Advanced Search" title="Advanced Search" data-slot="advanced-search-open"
                    onClick={() => setSearchOpen(true)} className="inline-grid size-6 place-items-center rounded text-muted-foreground hover:text-foreground">
                    <Search className="size-3.5" />
                  </button>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={shown.length + (lead ? 1 : 0) + (advancedSearch ? 1 : 0)} className="h-28 text-center text-sm text-muted-foreground">
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
                        // Wrap Text lets a long value run onto more lines; a narrowed column cuts it short.
                        wrap ? 'whitespace-normal break-words' : 'whitespace-nowrap',
                        !wrap && widths[c.key] && 'overflow-hidden text-ellipsis',
                        c.align === 'right' && 'text-right',
                        c.align === 'center' && 'text-center',
                        // The record's name in Zoho's link blue, on a list whose rows open.
                        onRowClick && c.key === primaryKey && 'font-medium text-link',
                        c.className,
                      )}
                      style={widths[c.key] ? { width: widths[c.key], maxWidth: widths[c.key] } : undefined}
                    >
                      {c.cell(row)}
                    </TableCell>
                  ))}
                  {advancedSearch && <TableCell className="w-10" />}
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
