'use client';

// The item list, as Zoho Books has it: "All Items ▾" (All, Active, Inactive,
// and Rekonza's Goods beside Zoho's Services), "+ New" and "⋯", and Zoho's
// columns: Name, SKU, Type, Description, Rate. Rekonza's own columns (HSN/SAC,
// unit, GST, how much has sold, the cost) wait under Customize Columns.
//
// An item opens beside the list (layout.tsx, Zoho's split view); New and Edit
// are pages of their own (components/sales/item-form.tsx). ?kind=goods or
// ?kind=service opens on that view.
//
// Zoho's ticks pick rows for Mark as Active, Mark as Inactive and Delete. Its
// "⋯", entry for entry: Sort by (Name, SKU, Rate), Import (Items, Opening
// Stock), Export (Items, Current View, Opening Stock, Item Images),
// Preferences, Refresh List, Reset Column Width, Validate HSN/SAC and HSN/SAC
// Update History; Rekonza's own after a rule. Only Name, SKU and Rate sort
// from their headings, as in Zoho.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, MoreHorizontal, Package, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub,
  DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { ItemGroupDialog } from '@/components/sales/item-group-dialog';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, resetColumnWidths, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { api, hsnCodes, items, type HsnCodeRow, type ItemRow } from '@/lib/api/client';
import { downloadCsv } from '@/components/shared/report-shell';
import { downloadFilesZip } from '@/lib/xlsx';
import type { ViewField } from '@/lib/custom-views';
import { useApi } from '@/lib/api/use-api';
import { useCanSeeCosts, usePermission } from '@/lib/store/hooks';

type View = 'all' | 'active' | 'inactive' | 'goods' | 'service';
type SortKey = 'name' | 'sku' | 'rate';

/** Zoho's "Sort by" choices for items: Name, SKU, Rate. */
const SORTS: { key: SortKey; label: string; value: (r: ItemRow) => string | number }[] = [
  { key: 'name', label: 'Name', value: (r) => r.name.toLowerCase() },
  { key: 'sku', label: 'SKU', value: (r) => (r.sku ?? '').toLowerCase() },
  { key: 'rate', label: 'Rate', value: (r) => r.salePricePaise },
];

/** What is wrong with an item's HSN or SAC, if anything (Zoho's "Validate HSN/SAC"). */
function hsnProblem(r: ItemRow, approved: Map<string, HsnCodeRow>): string | null {
  const code = r.hsnSac ?? '';
  if (!code) return r.kind === 'service' ? 'No SAC' : 'No HSN code';
  if (r.kind === 'service' && !/^99\d{4}$/.test(code)) return `${code} is not a SAC: a SAC is six digits starting 99`;
  if (r.kind === 'goods' && !/^\d{4}(\d{2}){0,2}$/.test(code)) return `${code} is not an HSN code: 4, 6 or 8 digits`;
  if (r.kind === 'goods' && code.startsWith('99')) return `${code} is a SAC, but this is goods`;
  const a = approved.get(code);
  if (!a) return `${code} is not on your approved codes`;
  if (a.gstRatePct !== r.gstRatePct) return `GST ${r.gstRatePct}% on the item, ${a.gstRatePct}% on the code`;
  return null;
}

/** A file name from an item: its SKU, else its name, made safe. */
const fileName = (r: ItemRow) => (r.sku || r.name).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || r.id;

interface HsnChange { id: string; at: string; actor: string | null; itemId: string | null; item: string | null; from: string | null; to: string | null }

export default function ItemsPage() {
  const router = useRouter();
  const canCreate = usePermission('sales', 'create');
  const canSeeCosts = useCanSeeCosts();
  const canImport = usePermission('accountant', 'view');
  const canEdit = usePermission('sales', 'edit');
  const canDelete = usePermission('sales', 'void');
  const canExport = usePermission('sales', 'export');
  const [grouping, setGrouping] = useState(false);
  const [sortBy, setSortBy] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
  const [checking, setChecking] = useState<{ item: ItemRow; problem: string }[] | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ rows: ItemRow[]; clear: () => void } | null>(null);
  const [hsnHistory, setHsnHistory] = useState<HsnChange[] | null>(null);
  // The view chosen last in this tab, shared with the column beside an open item (Zoho keeps it).
  const [view, setViewState] = useState<View>('active');
  const setView = (v: View) => {
    setViewState(v);
    try { sessionStorage.setItem('rekonza.view.items', v); } catch { /* this page only */ }
  };
  useEffect(() => {
    const k = new URLSearchParams(window.location.search).get('kind');
    if (k === 'goods' || k === 'service') { setView(k); return; }
    try {
      const kept = sessionStorage.getItem('rekonza.view.items');
      if (kept && ['all', 'active', 'inactive', 'goods', 'service'].includes(kept)) setViewState(kept as View);
    } catch { /* Zoho's default stands */ }
  }, []);

  // Every item, inactive ones too, so the views switch without a reload.
  const state = useApi<{ items: ItemRow[] }>(() => items.list({ archived: true }), []);
  const all = useMemo(() => state.data?.items ?? [], [state.data]);
  const active = useMemo(() => all.filter((i) => !i.isArchived), [all]);
  const tabs = useMemo(() => [
    { value: 'all', label: 'All', count: all.length },
    { value: 'active', label: 'Active', count: active.length },
    { value: 'inactive', label: 'Inactive', count: all.length - active.length },
    { value: 'goods', label: 'Goods', title: 'Goods', count: active.filter((i) => i.kind === 'goods').length },
    { value: 'service', label: 'Services', title: 'Services', count: active.filter((i) => i.kind === 'service').length },
  ], [all, active]);
  const viewRows = view === 'all' ? all
    : view === 'inactive' ? all.filter((i) => i.isArchived)
      : view === 'active' ? active
        : active.filter((i) => i.kind === view);
  const rows = useMemo(() => {
    const s = SORTS.find((x) => x.key === sortBy.key)!;
    return [...viewRows].sort((a, b) => {
      const va = s.value(a);
      const vb = s.value(b);
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return sortBy.dir === 'asc' ? cmp : -cmp;
    });
  }, [viewRows, sortBy]);
  const chooseSort = (key: SortKey) => setSortBy((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));

  /** Mark the ticked items active or inactive, one by one; a refusal is reported, the rest go ahead. */
  const setActive = async (picked: ItemRow[], clear: () => void, makeActive: boolean) => {
    const todo = picked.filter((r) => r.isArchived === makeActive);
    if (!todo.length) { toast.info(makeActive ? 'They are all active already.' : 'They are all inactive already.'); return; }
    setBulkBusy(true);
    const failed: string[] = [];
    for (const r of todo) {
      try { await items.update({ id: r.id, isArchived: !makeActive, expectedUpdatedAt: r.updatedAt }); }
      catch (e) { failed.push(`${r.name}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    setBulkBusy(false);
    const done = todo.length - failed.length;
    if (done) toast.success(`${done} item${done === 1 ? '' : 's'} marked as ${makeActive ? 'active' : 'inactive'}`);
    if (failed.length) toast.error(`${failed.length} not changed`, { description: failed.slice(0, 3).join(' · ') });
    clear();
    state.refetch();
  };
  const removeMany = async () => {
    if (!confirmDelete) return;
    setBulkBusy(true);
    const failed: string[] = [];
    for (const r of confirmDelete.rows) {
      try { await items.remove(r.id); }
      catch (e) { failed.push(`${r.name}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    setBulkBusy(false);
    const done = confirmDelete.rows.length - failed.length;
    if (done) toast.success(`${done} item${done === 1 ? '' : 's'} deleted`);
    if (failed.length) toast.error(`${failed.length} kept: still in use`, { description: failed.slice(0, 3).join(' · ') });
    confirmDelete.clear();
    setConfirmDelete(null);
    state.refetch();
  };

  /** The view as it stands, as a CSV: Zoho's "Export Current View". */
  const exportView = () => {
    downloadCsv(`items-${view}.csv`, [
      ['Name', 'SKU', 'Type', 'Description', 'Rate', 'HSN/SAC', 'Unit', 'GST rate', 'Status'],
      ...rows.map((r) => [r.name, r.sku ?? '', r.kind === 'service' ? 'Service' : 'Goods', r.description ?? '', (r.salePricePaise / 100).toFixed(2), r.hsnSac ?? '', r.uqc, r.gstRatePct, r.isArchived ? 'Inactive' : 'Active']),
    ]);
  };
  /** Zoho's "Export Opening Stock": each stocked item's opening quantity (and, for those who see costs, its rate). */
  const exportOpening = () => {
    const stocked = all.filter((r) => r.kind === 'goods' && r.trackInventory);
    downloadCsv('opening-stock.csv', [
      ['Name', 'SKU', 'Unit', 'Opening Stock', ...(canSeeCosts ? ['Opening Stock Rate', 'Opening Stock Value'] : [])],
      ...stocked.map((r) => {
        const qty = r.openingStockQty ?? 0;
        const rate = r.openingStockRatePaise ?? r.purchasePricePaise;
        return [r.name, r.sku ?? '', r.uqc, qty, ...(canSeeCosts ? [(rate / 100).toFixed(2), ((qty * rate) / 100).toFixed(2)] : [])];
      }),
    ]);
  };
  /** Zoho's "Export Item Images": every item's picture, in one zip, named by SKU. */
  const exportImages = async () => {
    const pictured = all.filter((r) => r.imageFileId);
    if (!pictured.length) { toast.info('No item has a picture yet.'); return; }
    const files: [string, Uint8Array][] = [];
    for (const r of pictured) {
      try {
        const res = await fetch(`/api/files/${r.imageFileId}`);
        if (!res.ok) continue;
        const ext = (res.headers.get('content-type') ?? '').includes('png') ? 'png' : (res.headers.get('content-type') ?? '').includes('webp') ? 'webp' : 'jpg';
        files.push([`${fileName(r)}.${ext}`, new Uint8Array(await res.arrayBuffer())]);
      } catch { /* a picture that will not load is left out */ }
    }
    if (!files.length) { toast.error('The pictures could not be read.'); return; }
    downloadFilesZip('item-images.zip', files);
  };
  const showHsnHistory = async () => {
    try {
      setHsnHistory((await api.get<{ entries: HsnChange[] }>('/api/items/hsn-history')).entries);
    } catch (e) {
      toast.error('The history could not be read', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const validateHsn = async () => {
    try {
      const { hsnCodes: codes } = await hsnCodes.list({ activeOnly: true });
      const approved = new Map(codes.map((c) => [c.code, c]));
      setChecking(active.map((item) => ({ item, problem: hsnProblem(item, approved) })).filter((x): x is { item: ItemRow; problem: string } => !!x.problem));
    } catch (e) {
      toast.error('The codes could not be read', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  // What a custom view's criteria can test (Zoho's "New View").
  const viewFields: ViewField<ItemRow>[] = [
    { key: 'name', label: 'Name', type: 'text', value: (r) => r.name },
    { key: 'sku', label: 'SKU', type: 'text', value: (r) => r.sku },
    { key: 'type', label: 'Type', type: 'choice', options: ['Goods', 'Service'], value: (r) => (r.kind === 'service' ? 'Service' : 'Goods') },
    { key: 'status', label: 'Status', type: 'choice', options: ['Active', 'Inactive'], value: (r) => (r.isArchived ? 'Inactive' : 'Active') },
    { key: 'description', label: 'Description', type: 'text', value: (r) => r.description },
    { key: 'rate', label: 'Rate', type: 'number', value: (r) => r.salePricePaise / 100 },
    ...(canSeeCosts ? [{ key: 'cost', label: 'Cost Price', type: 'number' as const, value: (r: ItemRow) => r.purchasePricePaise / 100 }] : []),
    { key: 'hsn', label: 'HSN/SAC', type: 'text', value: (r) => r.hsnSac },
    { key: 'unit', label: 'Unit', type: 'text', value: (r) => r.uqc },
    { key: 'gst', label: 'GST rate', type: 'number', value: (r) => r.gstRatePct },
    { key: 'sold', label: 'Quantity sold', type: 'number', value: (r) => r.qtySold },
    { key: 'created', label: 'Created Time', type: 'date', value: (r) => r.createdAt?.slice(0, 10) },
  ];

  const columns: Column<ItemRow>[] = [
    { key: 'name', header: 'Name', sortValue: (r) => r.name, cell: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'sku', header: 'SKU', sortValue: (r) => r.sku ?? '', cell: (r) => r.sku ?? '' },
    { key: 'type', header: 'Type', sortable: false, sortValue: (r) => r.kind, cell: (r) => (r.kind === 'service' ? 'Service' : 'Goods') },
    {
      key: 'description', header: 'Description', sortable: false, sortValue: (r) => r.description ?? '',
      cell: (r) => <span className="line-clamp-1 max-w-[420px]">{r.description ?? ''}</span>,
    },
    { key: 'rate', header: 'Rate', align: 'right', sortValue: (r) => r.salePricePaise, cell: (r) => <Money value={r.salePricePaise} /> },
    // Rekonza's own, under Customize Columns.
    { key: 'hsn', header: 'HSN/SAC', defaultHidden: true, sortValue: (r) => r.hsnSac ?? '', cell: (r) => r.hsnSac ?? '—' },
    {
      key: 'uqc', header: 'Unit', defaultHidden: true, sortValue: (r) => r.uqc,
      cell: (r) => <>{r.uqc}{r.altUqc && r.altFactor ? <span className="text-muted-foreground"> · 1 {r.altUqc} = {r.altFactor}</span> : null}</>,
    },
    { key: 'gst', header: 'GST', align: 'right', defaultHidden: true, sortValue: (r) => r.gstRatePct, cell: (r) => <span className="tabular">{r.gstRatePct}%</span> },
    {
      key: 'sold', header: 'Sold', align: 'right', defaultHidden: true, sortValue: (r) => r.qtySold,
      cell: (r) => <span className="tabular">{r.qtySold > 0 ? `${r.qtySold} ${r.uqc.toLowerCase()}` : '—'}</span>,
    },
    ...(canSeeCosts
      ? [{
          key: 'cost', header: 'Cost price', align: 'right' as const, defaultHidden: true,
          sortValue: (r: ItemRow) => r.purchasePricePaise,
          cell: (r: ItemRow) => <Money value={r.purchasePricePaise} />,
        }]
      : []),
    {
      key: 'mrp', header: 'MRP', align: 'right', defaultHidden: true, sortValue: (r) => r.mrpPaise ?? 0,
      cell: (r) => (r.mrpPaise !== null ? <Money value={r.mrpPaise} /> : '—'),
    },
  ];

  return (
    <>
      <PageHeader
        title="Items"
        description={
          canSeeCosts
            ? 'HSN/SAC codes and GST rates flow automatically onto every invoice and bill. Open an item to see it, its transactions and its history.'
            : 'Cost prices are hidden for your role.'
        }
        actions={
          <div className="flex gap-2">
            {canCreate && (
              <Button size="sm" asChild className="gap-1.5">
                <Link href="/sales/items/new" data-slot="new-item"><Plus className="size-4" /> New</Link>
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger aria-label="More" data-slot="items-more"
                className="grid size-[33px] place-items-center rounded-[var(--radius-button)] border border-secondary-border bg-secondary hover:brightness-[0.98]">
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger data-slot="items-sort">Sort by</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-48">
                    {SORTS.map((s) => (
                      <DropdownMenuItem key={s.key} onClick={() => chooseSort(s.key)} data-slot="items-sort-option" data-value={s.key} className="justify-between">
                        {s.label}
                        {sortBy.key === s.key && (sortBy.dir === 'asc' ? <ArrowUp className="size-3.5 text-primary" /> : <ArrowDown className="size-3.5 text-primary" />)}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                {canImport && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Import</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="min-w-48">
                      <DropdownMenuItem onClick={() => router.push('/settings/import')}>Import Items</DropdownMenuItem>
                      {/* Opening stock comes in on the item rows: their opening quantity and rate. */}
                      <DropdownMenuItem onClick={() => router.push('/settings/import')}>Import Opening Stock</DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                {(canImport || canExport) && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Export</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="min-w-52">
                      {canImport && <DropdownMenuItem onClick={() => router.push('/settings/export')}>Export Items</DropdownMenuItem>}
                      {canExport && <DropdownMenuItem onClick={exportView} data-slot="export-view">Export Current View</DropdownMenuItem>}
                      {canExport && <DropdownMenuItem onClick={exportOpening} data-slot="export-opening">Export Opening Stock</DropdownMenuItem>}
                      {canExport && <DropdownMenuItem onClick={() => void exportImages()} data-slot="export-images">Export Item Images</DropdownMenuItem>}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                <DropdownMenuItem onClick={() => router.push('/settings?tab=policies')}>Preferences</DropdownMenuItem>
                <DropdownMenuItem onClick={() => state.refetch()}>Refresh List</DropdownMenuItem>
                <DropdownMenuItem onClick={resetColumnWidths} data-slot="reset-widths">Reset Column Width</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void validateHsn()} data-slot="validate-hsn">Validate HSN/SAC</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void showHsnHistory()} data-slot="hsn-history">HSN/SAC Update History</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => router.push('/settings/hsn-codes')}>HSN and SAC codes</DropdownMenuItem>
                {canCreate && <DropdownMenuItem onClick={() => setGrouping(true)}>New Item Group</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />
      <AsyncPage state={state}>
        {(d) =>
          d.items.length === 0 ? (
            <EmptyState icon={Package} title="No items yet" description="Add what you sell to speed up invoicing." />
          ) : (
            <DataTable
              rows={rows}
              columns={columns}
              getRowId={(r) => r.id}
              selectable={canEdit || canDelete}
              bulkActions={(picked, clear) => (
                <div className="flex flex-wrap gap-2" data-slot="items-bulk">
                  {canEdit && <Button size="sm" variant="outline" disabled={bulkBusy} onClick={() => void setActive(picked, clear, true)}>Mark as Active</Button>}
                  {canEdit && <Button size="sm" variant="outline" disabled={bulkBusy} onClick={() => void setActive(picked, clear, false)}>Mark as Inactive</Button>}
                  {canDelete && <Button size="sm" variant="outline" disabled={bulkBusy} onClick={() => setConfirmDelete({ rows: picked, clear })}>Delete</Button>}
                </div>
              )}
              onRowClick={(r) => router.push(`/sales/items/${r.id}`)}
              searchPlaceholder="Search item, SKU or HSN…"
              emptyMessage={view === 'goods' ? 'No goods match.' : view === 'service' ? 'No services match.' : 'No items match.'}
              tabs={tabs}
              activeTab={view}
              onTabChange={(v) => setView(v as View)}
              customViews={{ list: 'items', baseTab: 'all', fields: viewFields }}
            />
          )
        }
      </AsyncPage>
      <ItemGroupDialog open={grouping} onOpenChange={setGrouping} onCreated={() => state.refetch()} />
      <Dialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {confirmDelete?.rows.length} item{confirmDelete?.rows.length === 1 ? '' : 's'}?</DialogTitle>
            <DialogDescription>Only items never used are deleted. One on a document, a price list or in stock is kept: mark it as inactive instead.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button variant="destructive" disabled={bulkBusy} onClick={() => void removeMany()} data-slot="items-bulk-delete-confirm">{bulkBusy ? 'Deleting…' : 'Delete'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!hsnHistory} onOpenChange={(o) => !o && setHsnHistory(null)}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-xl" data-slot="hsn-history-dialog">
          <DialogHeader>
            <DialogTitle>HSN/SAC Update History</DialogTitle>
            <DialogDescription>Every change of an item&apos;s HSN or SAC code, newest first.</DialogDescription>
          </DialogHeader>
          {hsnHistory?.length ? (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-table-head text-left text-[11px] uppercase text-muted-foreground">
                  <th className="px-2 py-1.5 font-normal">Date</th><th className="px-2 py-1.5 font-normal">Item</th>
                  <th className="px-2 py-1.5 font-normal">Old</th><th className="px-2 py-1.5 font-normal">New</th><th className="px-2 py-1.5 font-normal">By</th>
                </tr>
              </thead>
              <tbody>
                {hsnHistory.map((h) => (
                  <tr key={h.id} className="border-b">
                    <td className="whitespace-nowrap px-2 py-1.5">{new Date(h.at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                    <td className="px-2 py-1.5">{h.itemId ? <Link href={`/sales/items/${h.itemId}`} className="text-link hover:underline">{h.item}</Link> : h.item}</td>
                    <td className="px-2 py-1.5 font-mono">{h.from ?? '—'}</td>
                    <td className="px-2 py-1.5 font-mono">{h.to ?? '—'}</td>
                    <td className="px-2 py-1.5">{h.actor ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="py-6 text-center text-[13px] text-muted-foreground">No item&apos;s HSN or SAC code has been changed yet.</p>
          )}
          <DialogFooter><Button onClick={() => setHsnHistory(null)}>Done</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!checking} onOpenChange={(o) => !o && setChecking(null)}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg" data-slot="hsn-check">
          <DialogHeader>
            <DialogTitle>Validate HSN/SAC</DialogTitle>
            <DialogDescription>
              {checking?.length ? `${checking.length} of ${active.length} active items need their code looked at before GSTR-1.` : `All ${active.length} active items carry a valid, approved code at its rate.`}
            </DialogDescription>
          </DialogHeader>
          {!!checking?.length && (
            <ul className="divide-y text-[13px]">
              {checking.map(({ item, problem }) => (
                <li key={item.id} className="flex items-start justify-between gap-3 py-2" data-slot="hsn-problem">
                  <Link href={`/sales/items/${item.id}/edit`} className="text-link hover:underline">{item.name}</Link>
                  <span className="text-right text-muted-foreground">{problem}</span>
                </li>
              ))}
            </ul>
          )}
          <DialogFooter><Button onClick={() => setChecking(null)}>Done</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
