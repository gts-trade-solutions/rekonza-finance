'use client';

// ─────────────────────────────────────────────────────────────────────────────
// One item, as Zoho Books opens it beside the item list (the list is the
// layout's: components/shared/record-split.tsx).
//
// Zoho's header: the name at 22px, a pencil to edit, "More ▾" (Clone Item,
// Mark as Inactive, Delete), and the X to go back to the list. Under it three
// tabs:
//   Overview      the master as label and value: Item Type, SKU, HSN Code or
//                 SAC, Unit, Tax Preference; then Purchase Information, Sales
//                 Information and Default Tax Rates.
//   Transactions  "Filter By: Quotes ▾" and "Status: All ▾" over the
//                 documents the item is on.
//   History       the item's edit log; "No Recent History" when there is none.
//
// What Rekonza keeps that Zoho has not (stock on hand, the kit, batches and
// serials, MRP, the picture) sits in the same places in Zoho's look.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { ItemImageField } from '@/components/sales/item-image';
import { refreshSplitList, useSplitRecordRefresh } from '@/components/shared/record-split';
import { usePublishPageTitle } from '@/components/layout/page-context';
import { items, type ItemDetail, type ItemHistoryEntry, type ItemTxKind, type ItemTxRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useCanSeeCosts, usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';

const day = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const stamp = (d: string) => new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const TAX_PREF: Record<string, string> = { taxable: 'Taxable', exempt: 'Exempt', nil: 'Nil rated', non_gst: 'Non-GST supply' };

// ── Overview ────────────────────────────────────────────────────────────────

/** Zoho's label and value: a 134px label in light grey, the value beside it. */
function Row({ label, children, slot }: { label: string; children: ReactNode; slot?: string }) {
  return (
    <div className="grid grid-cols-[134px_1fr] items-start py-[4.5px]" data-slot={slot ?? 'item-field'}>
      <dt className="pr-3 text-[13px] font-light leading-[21px] text-[#777] dark:text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-[13px] leading-[21px]">{children}</dd>
    </div>
  );
}

function Section({ title, children, slot }: { title: string; children: ReactNode; slot?: string }) {
  return (
    <section className="mt-10" data-slot={slot}>
      <h3 className="pb-2.5 text-[15px] font-normal leading-[24px]">{title}</h3>
      <dl>{children}</dl>
    </section>
  );
}

/** Zoho's item type: kept in stock, or sold, bought, or both (the form's two ticks). */
function itemType(d: ItemDetail): string {
  const it = d.item;
  if (it.kind === 'goods' && it.trackInventory) return 'Inventory Items';
  if (it.itemType === 'sales') return 'Sales Items';
  if (it.itemType === 'purchases') return 'Purchase Items';
  return 'Sales and Purchase Items';
}

const acct = (a: { code: string; name: string } | null) => (a ? a.name : '—');

function Overview({ d, canEdit, onPicture }: { d: ItemDetail; canEdit: boolean; onPicture: () => void }) {
  const seesCosts = useCanSeeCosts();
  const it = d.item;
  const goods = it.kind === 'goods';
  const qty = (n: number) => `${n.toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${it.uqc}`;
  return (
    <div className="flex flex-col gap-10 px-5 pb-10 pt-6 xl:flex-row" data-slot="item-overview">
      <div className="min-w-0 max-w-[720px] flex-1">
        <dl>
          <Row label="Item Type">{itemType(d)}</Row>
        </dl>
        <dl className="mt-2.5">
          {it.sku && <Row label="SKU">{it.sku}</Row>}
          <Row label={goods ? 'HSN Code' : 'SAC'}>{it.hsnSac || '—'}</Row>
          <Row label="Unit">
            {it.uqc}
            {it.altUqc && it.altFactor ? <span className="text-muted-foreground"> · 1 {it.altUqc} = {it.altFactor} {it.uqc}</span> : null}
          </Row>
          {it.upc && <Row label="UPC">{it.upc}</Row>}
          {it.mpn && <Row label="MPN">{it.mpn}</Row>}
          {it.ean && <Row label="EAN">{it.ean}</Row>}
          {it.isbn && <Row label="ISBN">{it.isbn}</Row>}
          {!goods && it.isDigitalService && <Row label="Digital Service">Yes (online information and database access)</Row>}
          <Row label="Created Source">{it.createdSource === 'import' ? 'Import' : 'User'}</Row>
          <Row label={goods ? 'Comes from' : 'Provided from'}>
            {it.origin === 'imported' ? (goods ? 'Imported' : 'From abroad') : goods ? 'Local' : 'From India'}
          </Row>
          <Row label="Tax Preference">{TAX_PREF[it.taxPref] ?? it.taxPref}</Row>
          {it.isKit && <Row label="Sold as">A kit of {d.components.length}</Row>}
        </dl>

        {seesCosts && it.itemType !== 'sales' && (
          <Section title="Purchase Information" slot="item-purchase-info">
            <Row label="Cost Price"><Money value={it.purchasePricePaise} /></Row>
            <Row label="Purchase Account">{acct(d.purchaseAccount)}</Row>
            {it.purchaseDescription && <Row label="Description">{it.purchaseDescription}</Row>}
            {d.preferredVendor && (
              <Row label="Preferred Vendor">
                <Link href={`/purchases/vendors/${d.preferredVendor.id}`} className="text-link hover:underline" data-slot="preferred-vendor">{d.preferredVendor.name}</Link>
              </Row>
            )}
            {it.standardCostPaise !== null && <Row label="Standard cost"><Money value={it.standardCostPaise} /></Row>}
          </Section>
        )}

        {it.itemType !== 'purchases' && (
          <Section title="Sales Information" slot="item-sales-info">
            <Row label="Selling Price"><Money value={it.salePricePaise} /></Row>
            <Row label="Sales Account">{acct(d.saleAccount)}</Row>
            {it.description && <Row label="Description">{it.description}</Row>}
            {it.mrpPaise !== null && <Row label="MRP"><Money value={it.mrpPaise} /></Row>}
            <Row label="Sold so far" slot="item-sold">
              {it.qtySold > 0 ? <>{qty(it.qtySold)} for <Money value={it.soldValuePaise} /></> : 'Not sold yet'}
            </Row>
          </Section>
        )}

        {it.taxPref === 'taxable' && (
          <Section title="Default Tax Rates" slot="item-tax-rates">
            <Row label="Intra State Tax Rate">{`GST${it.gstRatePct} (${it.gstRatePct} %)`}</Row>
            <Row label="Inter State Tax Rate">{`IGST${it.gstRatePct} (${it.gstRatePct} %)`}</Row>
          </Section>
        )}

        <section className="mt-10" data-slot="item-tags">
          <h3 className="pb-2.5 text-[15px] font-normal leading-[24px]">Reporting Tags</h3>
          {d.tags.length ? (
            <dl>{d.tags.map((t) => <Row key={t.tagId} label={t.tag}>{t.option}</Row>)}</dl>
          ) : (
            <p className="text-[13px] text-muted-foreground">No reporting tag has been associated with this item.</p>
          )}
        </section>

        <section className="mt-10" data-slot="item-price-lists">
          <h3 className="pb-2.5 text-[15px] font-normal leading-[24px]">Associated Price Lists</h3>
          {d.priceLists.length ? (
            <table className="w-full max-w-[520px] border-collapse text-[13px]">
              <thead>
                <tr className="bg-table-head text-left text-[11px] uppercase text-muted-foreground">
                  <th className="px-2 py-1.5 font-normal">Name</th>
                  <th className="px-2 py-1.5 text-right font-normal">Price</th>
                </tr>
              </thead>
              <tbody>
                {d.priceLists.map((p) => (
                  <tr key={p.id} className="border-b">
                    <td className="px-2 py-2"><Link href="/sales/price-lists" className="text-link hover:underline">{p.name}</Link>{!p.isActive && <span className="ml-2 text-[11px] text-muted-foreground">(inactive)</span>}</td>
                    <td className="px-2 py-2 text-right"><Money value={p.ratePaise} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-[13px] text-muted-foreground">This item is not on any price list.</p>
          )}
        </section>

        {goods && it.trackInventory && (
          <Section title="Inventory" slot="item-inventory">
            <Row label="Opening Stock">{it.openingStockQty !== null ? qty(it.openingStockQty) : '—'}</Row>
            {seesCosts && it.openingStockRatePaise !== null && <Row label="Opening Stock Rate"><Money value={it.openingStockRatePaise} /></Row>}
            <Row label="Reorder Point">{it.reorderLevel !== null ? qty(it.reorderLevel) : '—'}</Row>
            {it.minLevel !== null && <Row label="Minimum level">{qty(it.minLevel)}</Row>}
            {d.stockGroupName && <Row label="Stock group">{d.stockGroupName}</Row>}
            <Row label="Valued by">{it.valuationMethod === 'fifo' ? 'First in, first out' : it.valuationMethod === 'average' ? 'Weighted average' : 'The book’s method'}</Row>
            {it.trackBatches && <Row label="Batches">Tracked, with expiry</Row>}
            {it.trackSerials && <Row label="Serial numbers">Tracked</Row>}
          </Section>
        )}

        {it.isKit && (
          <Section title="Kit Components" slot="item-kit">
            {d.components.map((c) => (
              <Row key={c.itemId} label={`${c.qty.toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${c.uqc}`}>
                <Link href={`/sales/items/${c.itemId}`} className="text-link hover:underline">{c.name}</Link>
              </Row>
            ))}
          </Section>
        )}
      </div>

      <aside className="w-full shrink-0 space-y-6 xl:w-[300px]">
        <div className="rounded-[var(--radius-card)] border border-dashed p-4" data-slot="item-picture">
          <ItemImageField itemId={it.id} fileId={it.imageFileId} name={it.name} canEdit={canEdit} onChanged={onPicture} />
        </div>
        {d.stock && (
          <div className="rounded-[var(--radius-card)] border p-4" data-slot="item-stock">
            <h4 className="mb-3 text-[14px] font-medium">Stock</h4>
            <dl className="space-y-2 text-[13px]">
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Stock on Hand</dt><dd className="tabular font-medium" data-slot="stock-on-hand">{qty(d.stock.onHand)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Committed Stock</dt><dd className="tabular">{qty(d.stock.committed)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Available for Sale</dt><dd className={cn('tabular', d.stock.available < 0 && 'text-destructive')}>{qty(d.stock.available)}</dd></div>
              {d.stock.valuePaise !== null && (
                <div className="flex justify-between gap-3 border-t pt-2"><dt className="text-muted-foreground">Stock value</dt><dd><Money value={d.stock.valuePaise} /></dd></div>
              )}
            </dl>
          </div>
        )}
      </aside>
    </div>
  );
}

// ── Transactions ────────────────────────────────────────────────────────────

/** Zoho's "Filter By" list, in Zoho's order; Debit Notes is Rekonza's. Vendor credits carry no item lines. */
const KINDS: { kind: ItemTxKind; label: string; number: string; side: 'sales' | 'purchases'; statuses: string[] }[] = [
  { kind: 'estimate', label: 'Quotes', number: 'Quote Number', side: 'sales', statuses: ['draft', 'sent', 'accepted', 'converted', 'declined', 'expired'] },
  { kind: 'sales_order', label: 'Sales Orders', number: 'Sales Order#', side: 'sales', statuses: ['open', 'partially_invoiced', 'invoiced', 'closed', 'cancelled'] },
  { kind: 'invoice', label: 'Invoices', number: 'Invoice Number', side: 'sales', statuses: ['draft', 'approved', 'sent', 'overdue', 'partially_paid', 'paid', 'void'] },
  { kind: 'challan', label: 'Delivery Challans', number: 'Delivery Challan#', side: 'sales', statuses: ['open', 'partially_invoiced', 'invoiced', 'returned', 'cancelled'] },
  { kind: 'credit_note', label: 'Credit Notes', number: 'Credit Note#', side: 'sales', statuses: ['open', 'applied', 'refunded', 'void'] },
  { kind: 'debit_note', label: 'Debit Notes', number: 'Debit Note#', side: 'sales', statuses: ['draft', 'approved', 'sent', 'partially_paid', 'paid', 'void'] },
  { kind: 'recurring_invoice', label: 'Recurring Invoices', number: 'Profile Name', side: 'sales', statuses: ['active', 'stopped', 'expired'] },
  { kind: 'purchase_order', label: 'Purchase Orders', number: 'Purchase Order#', side: 'purchases', statuses: ['draft', 'open', 'partially_billed', 'billed', 'closed', 'cancelled'] },
  { kind: 'bill', label: 'Bills', number: 'Bill#', side: 'purchases', statuses: ['draft', 'open', 'overdue', 'partially_paid', 'paid', 'void'] },
];

const label = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

function txHref(r: ItemTxRow): string {
  switch (r.kind) {
    case 'invoice': case 'debit_note': return `/sales/invoices/${r.id}`;
    case 'bill': return `/purchases/bills/${r.id}`;
    case 'estimate': return `/print/estimate/${r.id}`;
    case 'sales_order': return `/print/sales-order/${r.id}`;
    case 'challan': return `/print/challan/${r.id}`;
    case 'credit_note': return `/print/credit-note/${r.id}`;
    case 'purchase_order': return `/print/purchase-order/${r.id}`;
    case 'recurring_invoice': return '/sales/recurring';
  }
}

/** Zoho's grey filter button: "Filter By: Quotes ▾". */
function FilterMenu({ prefix, value, options, onChange, slot }: {
  prefix: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; slot: string;
}) {
  const current = options.find((o) => o.value === value) ?? options[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-slot={slot}
        className="inline-flex h-[33px] items-center gap-1.5 rounded-[var(--radius-button)] border border-secondary-border bg-secondary px-2.5 text-[13px] outline-none hover:brightness-[0.98] focus-visible:ring-2 focus-visible:ring-ring/30"
      >
        <span className="text-muted-foreground">{prefix}</span>
        <span>{current?.label}</span>
        <ChevronDown className="size-3.5" strokeWidth={2.2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        {options.map((o) => (
          <DropdownMenuItem key={o.value} data-slot={`${slot}-option`} data-value={o.value} onClick={() => onChange(o.value)} className={cn(o.value === value && 'font-medium')}>
            {o.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Transactions({ id }: { id: string }) {
  const state = useApi(() => items.transactions(id), [id]);
  const [kind, setKind] = useState<ItemTxKind>('estimate');
  const [status, setStatus] = useState('all');
  const kinds = KINDS.filter((k) => k.side === 'sales' || state.data?.purchases);
  const spec = KINDS.find((k) => k.kind === kind) ?? KINDS[0];
  const rows = useMemo(
    () => (state.data?.rows ?? []).filter((r) => r.kind === kind && (status === 'all' || r.status === status)),
    [state.data, kind, status],
  );
  const purchase = spec.side === 'purchases';
  return (
    <div className="px-5 pb-12 pt-5" data-slot="item-transactions">
      <div className="mb-4 flex flex-wrap gap-2.5">
        <FilterMenu
          prefix="Filter By:" slot="tx-filter" value={kind}
          options={kinds.map((k) => ({ value: k.kind, label: k.label }))}
          onChange={(v) => { setKind(v as ItemTxKind); setStatus('all'); }}
        />
        <FilterMenu
          prefix="Status:" slot="tx-status" value={status}
          options={[{ value: 'all', label: 'All' }, ...spec.statuses.map((s) => ({ value: s, label: label(s) }))]}
          onChange={setStatus}
        />
      </div>
      {state.loading && !state.data ? (
        <LoadingRows />
      ) : state.error ? (
        <p className="text-[13px] text-destructive">{state.error}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-[13px]" data-slot="tx-table">
            <thead>
              <tr className="bg-table-head text-left text-[11px] uppercase text-muted-foreground">
                <th className="px-1.5 py-1.5 font-normal">Date</th>
                <th className="px-1.5 py-1.5 font-normal">{spec.number}</th>
                <th className="px-1.5 py-1.5 font-normal">{purchase ? 'Vendor Name' : 'Customer Name'}</th>
                <th className="px-1.5 py-1.5 text-right font-normal">{purchase ? 'Quantity Purchased' : 'Quantity Sold'}</th>
                <th className="px-1.5 py-1.5 text-right font-normal">Price</th>
                <th className="px-1.5 py-1.5 text-right font-normal">Total</th>
                <th className="px-1.5 py-1.5 font-normal">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={7} className="px-1.5 py-10 text-center text-muted-foreground" data-slot="tx-empty">There are no {spec.label.toLowerCase()} with this item{status !== 'all' ? ` in ${label(status).toLowerCase()}` : ''}.</td></tr>
              ) : rows.map((r, i) => (
                <tr key={`${r.kind}-${r.id}-${i}`} className="border-b border-border align-top hover:bg-row-hover" data-slot="tx-row">
                  <td className="whitespace-nowrap px-1.5 py-[6.5px] leading-[21px]">{day(r.date)}</td>
                  <td className="px-1.5 py-[6.5px] leading-[21px]"><Link href={txHref(r)} className="text-link hover:underline">{r.number}</Link></td>
                  <td className="px-1.5 py-[6.5px] leading-[21px]">{r.party}</td>
                  <td className="px-1.5 py-[6.5px] text-right tabular leading-[21px]">{r.qty.toLocaleString('en-IN', { maximumFractionDigits: 3 })}</td>
                  <td className="px-1.5 py-[6.5px] text-right leading-[21px]"><Money value={r.ratePaise} /></td>
                  <td className="px-1.5 py-[6.5px] text-right leading-[21px]"><Money value={r.amountPaise} /></td>
                  <td className="px-1.5 py-[6.5px] leading-[21px]"><StatusBadge status={r.status} className="capitalize" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── History ─────────────────────────────────────────────────────────────────

function describe(e: ItemHistoryEntry): string {
  if (e.action === 'create') return 'Item created';
  if (e.changes.length) {
    const archived = e.changes.find((c) => c.field === 'Status');
    if (archived && e.changes.length === 1) return archived.to === 'Inactive' ? 'Item marked as inactive' : 'Item marked as active';
    return 'Item updated';
  }
  return e.detail ?? 'Item updated';
}

function History({ id }: { id: string }) {
  const state = useApi(() => items.history(id), [id]);
  if (state.loading && !state.data) return <div className="px-5 pt-5"><LoadingRows /></div>;
  if (state.error) return <p className="px-5 pt-5 text-[13px] text-destructive">{state.error}</p>;
  const entries = state.data?.entries ?? [];
  if (!entries.length) return <p className="px-5 py-16 text-center text-[13px] text-muted-foreground" data-slot="history-empty">No Recent History</p>;
  return (
    <ol className="px-5 pb-12 pt-6" data-slot="item-history">
      {entries.map((e, i) => (
        <li key={e.id} className="grid grid-cols-[150px_24px_1fr] gap-x-2" data-slot="history-entry">
          <time className="pt-0.5 text-[12px] text-muted-foreground" dateTime={e.at}>{stamp(e.at)}</time>
          <span className="relative flex justify-center">
            <span className="mt-1.5 size-2.5 rounded-full border-2 border-primary bg-background" />
            {i < entries.length - 1 && <span className="absolute bottom-0 top-5 w-px bg-border" />}
          </span>
          <div className="mb-4 rounded-[var(--radius-button)] border bg-background px-3.5 py-2.5">
            <p className="text-[13px] font-medium">{describe(e)}</p>
            {e.changes.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-[12px] text-muted-foreground">
                {e.changes.map((c) => (
                  <li key={c.field}>
                    {c.from === 'hidden' ? `${c.field} changed` : <>{c.field}: {c.from} → <span className="text-foreground">{c.to}</span></>}
                  </li>
                ))}
              </ul>
            )}
            {e.actor && <p className="mt-1 text-[12px] text-muted-foreground">by <span className="text-foreground">{e.actor}</span></p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

// ── The page ────────────────────────────────────────────────────────────────

function Header({ d, onChanged }: { d: ItemDetail; onChanged: () => void }) {
  const router = useRouter();
  const it = d.item;
  const canCreate = usePermission('sales', 'create');
  const canEdit = usePermission('sales', 'edit');
  const canDelete = usePermission('sales', 'void');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  usePublishPageTitle(it.name);

  const setActive = async (active: boolean) => {
    setBusy(true);
    try {
      await items.update({ id: it.id, isArchived: !active, expectedUpdatedAt: it.updatedAt });
      toast.success(active ? `${it.name} is active again` : `${it.name} is marked as inactive`);
      refreshSplitList();
      onChanged();
    } catch (e) {
      toast.error(active ? 'Not marked as active' : 'Not marked as inactive', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await items.remove(it.id);
      toast.success(`${it.name} deleted`);
      setConfirming(false);
      router.push('/sales/items');
    } catch (e) {
      toast.error('Not deleted', { description: e instanceof Error ? e.message : String(e) });
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-slot="item-header" className="-mx-6 -mt-5 flex min-h-[65px] items-center gap-3 py-3 pl-5 pr-[3.75rem]">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <h1 className="truncate text-[22px] font-normal leading-tight" data-slot="item-title">{it.name}</h1>
        {it.isArchived && <StatusBadge status="inactive" />}
      </div>
      <div className="flex shrink-0 items-center gap-2 no-print">
        {canEdit && (
          <Button variant="outline" size="icon" asChild aria-label="Edit" title="Edit" className="h-[34px] w-9">
            <Link href={`/sales/items/${it.id}/edit`} data-slot="item-edit"><Pencil className="size-4" strokeWidth={1.8} /></Link>
          </Button>
        )}
        {(canCreate || canEdit || canDelete) && (
          <DropdownMenu>
            <DropdownMenuTrigger
              data-slot="item-more"
              className="inline-flex h-[34px] items-center gap-1 rounded-[var(--radius-button)] border border-secondary-border bg-secondary px-2.5 text-[13px] outline-none hover:brightness-[0.98] focus-visible:ring-2 focus-visible:ring-ring/30"
            >
              More <ChevronDown className="size-3.5" strokeWidth={2.2} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              {canCreate && (
                <DropdownMenuItem onClick={() => router.push(`/sales/items/new?clone=${it.id}`)} data-slot="item-clone">Clone Item</DropdownMenuItem>
              )}
              {canEdit && (
                <DropdownMenuItem disabled={busy} onClick={() => void setActive(it.isArchived)} data-slot="item-toggle-active">
                  {it.isArchived ? 'Mark as Active' : 'Mark as Inactive'}
                </DropdownMenuItem>
              )}
              {canDelete && (
                <DropdownMenuItem onClick={() => setConfirming(true)} data-slot="item-delete">Delete</DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {it.name}?</DialogTitle>
            <DialogDescription>
              Only an item that was never used can be deleted. One that is on a document, a price list or in stock is kept: mark it as inactive instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="destructive" disabled={busy} onClick={() => void remove()} data-slot="item-delete-confirm">{busy ? 'Deleting…' : 'Delete'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function ItemPage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi(() => items.get(id), [id]);
  const canEdit = usePermission('sales', 'edit');
  const [tab, setTab] = useState('overview');
  // A bulk action ticked in the column beside it may have changed this item.
  useSplitRecordRefresh(state.refetch);
  return (
    <AsyncPage state={state}>
      {(d) => (
        <>
          <Header d={d} onChanged={state.refetch} />
          <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="-mx-6 gap-0">
            <TabsList className="w-full gap-x-0 px-5" data-slot="item-tabs">
              {[['overview', 'Overview'], ['transactions', 'Transactions'], ['history', 'History']].map(([v, l]) => (
                <TabsTrigger key={v} value={v} className="px-3.5 data-active:font-semibold">{l}</TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="overview"><Overview d={d} canEdit={canEdit} onPicture={state.refetch} /></TabsContent>
            <TabsContent value="transactions"><Transactions id={d.item.id} /></TabsContent>
            {/* Read again whenever the item changes (marked inactive, say), so the new entry shows. */}
            <TabsContent value="history"><History key={d.item.updatedAt} id={d.item.id} /></TabsContent>
          </Tabs>
        </>
      )}
    </AsyncPage>
  );
}
