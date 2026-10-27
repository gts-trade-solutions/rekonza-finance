'use client';

// The item catalogue.
//
// The HSN/SAC field is a picker over the organisation's approved codes, not a
// text box. GSTR-1 Table 12 is validated against the government's master and a
// code that is not on it bounces the whole return — so the list an admin
// curates under Settings is the only thing an item can carry. Typing "8" lists
// every approved code starting 8, which is how people actually look these up.
//
// Goods carry the rest of a stock item's master: MRP, a standard cost, a
// second unit, reorder and minimum levels, and batch or serial tracking. The
// same dialog adds an item and edits one; click a row to edit it.

import { useMemo, useState } from 'react';
import { Package, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { api, hsnCodes, items, type HsnCodeRow, type ItemRow } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { useCanSeeCosts, usePermission } from '@/lib/store/hooks';
import { GST_RATES } from '@/lib/tax/gst';

interface Loaded {
  items: ItemRow[];
  hsnCodes: HsnCodeRow[];
}

const BLANK = {
  name: '', sku: '', hsnSac: '', kind: 'goods' as 'goods' | 'service',
  uqc: 'NOS', salePrice: 0, purchasePrice: 0, gstRatePct: 18,
  openingQty: '', openingRate: 0, trackBatches: false, trackSerials: false,
  mrp: 0, standardCost: 0, altUqc: '', altFactor: '', reorderLevel: '', minLevel: '',
  stockGroupId: '', valuationMethod: '' as '' | 'average' | 'fifo',
};

/** A blank text box is "not set"; anything else has to be a number of zero or more. */
const qtyOrNull = (s: string): number | null | 'bad' => {
  if (!s.trim()) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : 'bad';
};
const digits = (s: string) => s.replace(/[^0-9.]/g, '');

export default function ItemsPage() {
  const canCreate = usePermission('sales', 'create');
  const canEdit = usePermission('sales', 'edit');
  const canSeeCosts = useCanSeeCosts();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ItemRow | null>(null);
  const [form, setForm] = useState(BLANK);

  const state = useApi<Loaded>(
    async () => {
      const [i, h] = await Promise.all([items.list(), hsnCodes.list({ activeOnly: true })]);
      return { items: i.items, hsnCodes: h.hsnCodes };
    },
    [],
  );

  // A goods item takes an HSN, a service a SAC. Offering both invites the
  // classification error that puts a supply in the wrong GSTR-1 table.
  const codeOptions = useMemo(
    () =>
      (state.data?.hsnCodes ?? [])
        .filter((h) => (form.kind === 'service' ? h.kind === 'sac' : h.kind === 'hsn'))
        .map((h) => ({
          value: h.code,
          label: h.code,
          sublabel: h.description,
          meta: `${h.gstRatePct}%`,
        })),
    [state.data, form.kind],
  );

  const groups = useApi(() => api.get<{ groups: { id: string; name: string; parentId: string | null }[] }>('/api/stock-groups'), []);
  const newGroup = async () => {
    const name = window.prompt('Name of the new stock group, such as Spares or Lubricants');
    if (!name?.trim()) return;
    try {
      const r = await api.post<{ id: string }>('/api/stock-groups', { name: name.trim() });
      await groups.refetch();
      setForm((x) => ({ ...x, stockGroupId: r.id }));
    } catch (e) {
      toast.error('Not added', { description: e instanceof Error ? e.message : String(e) });
    }
  };
  const create = useApiAction(items.create);
  const update = useApiAction(items.update);
  const action = editing ? update : create;

  const openNew = () => { setEditing(null); setForm(BLANK); setOpen(true); };
  const openEdit = (r: ItemRow) => {
    const s = (n: number | null) => (n === null ? '' : String(n));
    setEditing(r);
    setForm({
      name: r.name, sku: r.sku ?? '', hsnSac: r.hsnSac ?? '', kind: r.kind, uqc: r.uqc,
      salePrice: r.salePricePaise, purchasePrice: r.purchasePricePaise, gstRatePct: r.gstRatePct,
      openingQty: s(r.openingStockQty), openingRate: r.openingStockRatePaise ?? 0,
      trackBatches: !!r.trackBatches, trackSerials: r.trackSerials,
      mrp: r.mrpPaise ?? 0, standardCost: r.standardCostPaise ?? 0,
      altUqc: r.altUqc ?? '', altFactor: s(r.altFactor), reorderLevel: s(r.reorderLevel), minLevel: s(r.minLevel),
      stockGroupId: r.stockGroupId ?? '', valuationMethod: r.valuationMethod ?? '',
    });
    setOpen(true);
  };

  const save = async () => {
    if (!form.name.trim()) { toast.error('Item name is required'); return; }
    const goods = form.kind === 'goods';
    const openingQty = goods ? qtyOrNull(form.openingQty) : null;
    const reorderLevel = goods ? qtyOrNull(form.reorderLevel) : null;
    const minLevel = goods ? qtyOrNull(form.minLevel) : null;
    const altFactor = goods && form.altUqc.trim() ? qtyOrNull(form.altFactor) : null;
    if ([openingQty, reorderLevel, minLevel, altFactor].includes('bad')) {
      toast.error('Quantities are numbers of zero or more.');
      return;
    }
    const payload = {
      kind: form.kind,
      name: form.name.trim(),
      sku: form.sku || null,
      hsnSac: form.hsnSac || null,
      uqc: form.uqc || 'NOS',
      salePricePaise: form.salePrice,
      purchasePricePaise: form.purchasePrice,
      gstRatePct: form.gstRatePct,
      // An edit leaves stock tracking as it was.
      ...(editing ? {} : { trackInventory: goods }),
      trackBatches: goods && form.trackBatches,
      trackSerials: goods && form.trackSerials,
      openingStockQty: openingQty,
      // Left blank, the opening stock is carried at the purchase price.
      openingStockRatePaise: openingQty !== null && form.openingRate > 0 ? form.openingRate : null,
      mrpPaise: goods && form.mrp > 0 ? form.mrp : null,
      standardCostPaise: goods && form.standardCost > 0 ? form.standardCost : null,
      altUqc: goods && form.altUqc.trim() ? form.altUqc.trim().toUpperCase() : null,
      altFactor,
      reorderLevel,
      minLevel,
      stockGroupId: goods && form.stockGroupId ? form.stockGroupId : null,
      valuationMethod: goods && form.valuationMethod ? form.valuationMethod : null,
    };
    const result = editing
      ? await update.run({ ...payload, id: editing.id, expectedUpdatedAt: editing.updatedAt })
      : await create.run(payload);
    if (!result) return;
    toast.success(editing ? `${payload.name} saved` : `${payload.name} added`);
    setOpen(false);
    setEditing(null);
    setForm(BLANK);
    state.refetch();
  };

  const columns: Column<ItemRow>[] = [
    {
      key: 'name',
      header: 'Item',
      sortValue: (r) => r.name,
      cell: (r) => (
        <div>
          <p className="font-medium">{r.name}</p>
          <p className="text-xs text-muted-foreground">
            {r.sku ?? '—'}
            {r.trackSerials && ' · serial nos.'}
            {r.trackBatches && ' · batches'}
          </p>
        </div>
      ),
    },
    {
      key: 'kind',
      header: 'Type',
      sortValue: (r) => r.kind,
      cell: (r) => <Badge variant="secondary" className="capitalize text-[10px]">{r.kind}</Badge>,
    },
    {
      key: 'hsn',
      header: 'HSN/SAC',
      sortValue: (r) => r.hsnSac ?? '',
      cell: (r) => <span className="font-mono text-xs">{r.hsnSac ?? '—'}</span>,
    },
    {
      key: 'uqc', header: 'Unit', sortValue: (r) => r.uqc,
      cell: (r) => (
        <span className="text-xs">
          {r.uqc}
          {r.altUqc && r.altFactor && <span className="block text-[10px] text-muted-foreground">1 {r.altUqc} = {r.altFactor}</span>}
        </span>
      ),
    },
    {
      key: 'gst', header: 'GST', align: 'right',
      sortValue: (r) => r.gstRatePct,
      cell: (r) => <span className="tabular">{r.gstRatePct}%</span>,
    },
    {
      key: 'sold', header: 'Sold', align: 'right',
      sortValue: (r) => r.qtySold,
      cell: (r) => (
        <span className="tabular text-xs text-muted-foreground">
          {r.qtySold > 0 ? `${r.qtySold} ${r.uqc.toLowerCase()}` : '—'}
        </span>
      ),
    },
    ...(canSeeCosts
      ? [{
          key: 'cost',
          header: 'Cost price',
          align: 'right' as const,
          sortValue: (r: ItemRow) => r.purchasePricePaise,
          cell: (r: ItemRow) => <Money value={r.purchasePricePaise} className="text-muted-foreground" />,
        }]
      : []),
    {
      key: 'price', header: 'Sale price', align: 'right',
      sortValue: (r) => r.salePricePaise,
      cell: (r) => (
        <div>
          <Money value={r.salePricePaise} className="font-medium" />
          {r.mrpPaise !== null && <p className="text-[10px] text-muted-foreground">MRP <Money value={r.mrpPaise} /></p>}
        </div>
      ),
    },
  ];

  const set = (patch: Partial<typeof BLANK>) => setForm({ ...form, ...patch });

  return (
    <>
      <PageHeader
        title="Items & services"
        description={
          canSeeCosts
            ? 'HSN/SAC codes and GST rates flow automatically onto every invoice and bill. Click an item to edit it.'
            : 'Cost prices are hidden for your role.'
        }
        actions={canCreate && <Button size="sm" className="gap-1.5" onClick={openNew}><Plus className="size-4" /> New item</Button>}
      />
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setEditing(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{editing ? `Edit ${editing.name}` : 'New item'}</DialogTitle></DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" required error={action.fieldErrors.name} className="sm:col-span-2">
              <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Item name" />
            </Field>
            <Field label="Type">
              <Select value={form.kind} onValueChange={(v) => set({ kind: v as 'goods' | 'service', hsnSac: '' })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="goods">Goods</SelectItem>
                  <SelectItem value="service">Service</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="SKU">
              <Input value={form.sku} onChange={(e) => set({ sku: e.target.value })} placeholder="SKU-0001" />
            </Field>
            <Field
              label={form.kind === 'goods' ? 'HSN code' : 'SAC code'}
              hint="Only codes an admin has approved"
              error={action.fieldErrors.hsnSac}
            >
              <Combobox
                options={codeOptions}
                value={form.hsnSac}
                onChange={(v) => {
                  const picked = state.data?.hsnCodes.find((h) => h.code === v);
                  set({
                    hsnSac: v,
                    gstRatePct: picked ? picked.gstRatePct : form.gstRatePct,
                    uqc: picked?.uqc || form.uqc,
                  });
                }}
                placeholder={form.kind === 'goods' ? 'Type 8 for 8xxx…' : 'Type 99…'}
                searchPlaceholder="Type the first digits"
                matchMode="prefix"
                showAvatar={false}
                clearable
              />
            </Field>
            <Field label="Unit (UQC)">
              <Input value={form.uqc} onChange={(e) => set({ uqc: e.target.value })} placeholder="NOS" />
            </Field>
            <Field label="Sale price" error={action.fieldErrors.salePricePaise}>
              <MoneyInput valuePaise={form.salePrice} onChangePaise={(p) => set({ salePrice: p })} />
            </Field>
            <Field label="Purchase price">
              <MoneyInput valuePaise={form.purchasePrice} onChangePaise={(p) => set({ purchasePrice: p })} />
            </Field>
            <Field label="GST rate" className="sm:col-span-2">
              <Select value={String(form.gstRatePct)} onValueChange={(v) => set({ gstRatePct: Number(v) })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {GST_RATES.map((r) => <SelectItem key={r} value={String(r)}>{r}%</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            {form.kind === 'goods' && (
              <>
                <p className="border-t pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:col-span-2">Stock</p>
                <Field label="Stock group">
                  <select value={form.stockGroupId} onChange={(e) => (e.target.value === '__new' ? void newGroup() : set({ stockGroupId: e.target.value }))}
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                    <option value="">None</option>
                    {(groups.data?.groups ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    <option value="__new">+ New group…</option>
                  </select>
                </Field>
                <Field label="Valued by" hint="For closing stock">
                  <select value={form.valuationMethod} onChange={(e) => set({ valuationMethod: e.target.value as '' | 'average' | 'fifo' })}
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                    <option value="">The book&apos;s method</option>
                    <option value="average">Weighted average</option>
                    <option value="fifo">First in, first out</option>
                  </select>
                </Field>
                <Field label="MRP" hint="Printed on the pack. A sale above it is flagged.">
                  <MoneyInput valuePaise={form.mrp} onChangePaise={(p) => set({ mrp: p })} />
                </Field>
                <Field label="Standard cost" hint="Budgeted cost a unit, set against the actual.">
                  <MoneyInput valuePaise={form.standardCost} onChangePaise={(p) => set({ standardCost: p })} />
                </Field>
                <Field label="Second unit" hint="Bought or counted in, e.g. BOX">
                  <Input value={form.altUqc} onChange={(e) => set({ altUqc: e.target.value.toUpperCase() })} placeholder="BOX" maxLength={10} />
                </Field>
                <Field label={`${form.uqc || 'Units'} in one ${form.altUqc || 'second unit'}`}>
                  <Input value={form.altFactor} onChange={(e) => set({ altFactor: digits(e.target.value) })}
                    placeholder="12" inputMode="decimal" className="tabular" disabled={!form.altUqc.trim()} />
                </Field>
                <Field label="Reorder level" hint="Time to buy at or below this">
                  <Input value={form.reorderLevel} onChange={(e) => set({ reorderLevel: digits(e.target.value) })} placeholder="0" inputMode="decimal" className="tabular" />
                </Field>
                <Field label="Minimum level" hint="Short at or below this">
                  <Input value={form.minLevel} onChange={(e) => set({ minLevel: digits(e.target.value) })} placeholder="0" inputMode="decimal" className="tabular" />
                </Field>
                <Field label="Opening stock" hint="Quantity on hand when your books begin">
                  <Input value={form.openingQty} onChange={(e) => set({ openingQty: digits(e.target.value) })} placeholder="0" inputMode="decimal" className="tabular" />
                </Field>
                <Field label="Opening rate" hint="Cost per unit. Blank uses the purchase price.">
                  <MoneyInput valuePaise={form.openingRate} onChangePaise={(p) => set({ openingRate: p })} />
                </Field>
                <label className="flex items-start gap-2 text-sm sm:col-span-2">
                  <input type="checkbox" className="mt-1" checked={form.trackBatches} onChange={(e) => set({ trackBatches: e.target.checked })} />
                  <span>Track batches and expiry<span className="block text-xs text-muted-foreground">Each purchase names its batch and expiry; sales take the earliest to expire first. Opening stock is then entered as an adjustment, batch by batch.</span></span>
                </label>
                <label className="flex items-start gap-2 text-sm sm:col-span-2">
                  <input type="checkbox" className="mt-1" checked={form.trackSerials} onChange={(e) => set({ trackSerials: e.target.checked })} />
                  <span>Track serial numbers<span className="block text-xs text-muted-foreground">Each piece is named by its number as it is bought and sold, so any one can be traced for warranty or service. Pieces already on hand are entered as an adjustment, with their numbers.</span></span>
                </label>
              </>
            )}
            {action.error && <p className="text-sm text-destructive sm:col-span-2">{action.error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={action.busy}>
              {action.busy ? 'Saving…' : 'Save item'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AsyncPage state={state}>
        {(d) =>
          d.items.length === 0 ? (
            <EmptyState icon={Package} title="No items yet" description="Add what you sell to speed up invoicing." />
          ) : (
            <DataTable
              rows={d.items}
              columns={columns}
              getRowId={(r) => r.id}
              onRowClick={canEdit ? openEdit : undefined}
              searchPlaceholder="Search item, SKU or HSN…"
              emptyMessage="No items match."
            />
          )
        }
      </AsyncPage>
    </>
  );
}
