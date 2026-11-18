'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Zoho Books' "New Item" and "Edit Item": a page of its own, not a dialog.
//
// Zoho's order, measured from its demo: Type (Goods / Service), Name, SKU,
// Unit ("It is a digital service" under it for a service) and Tax Preference
// on a grey band; then Sales Information and Purchase Information side by
// side, each with its tick (an item sold, bought, or both), its price, its
// account and its description, and the preferred vendor on the purchase side;
// then Default Tax Rates, read-only until the pencil is pressed; then "Track
// Inventory for this item"; then Associate Tags. Save and Cancel sit in the
// bar at the foot.
//
// What Rekonza keeps that Zoho's form has not (its features, unchanged) comes
// in Zoho's look in the same places: the HSN/SAC picker over the approved
// codes (GSTR-1 Table 12 bounces a code not on the master), local or imported,
// MRP and standard cost, the stock group, valuation, a second unit, minimum
// level, batches and serial numbers, the kit, and the picture.
//
// What goods cost (the cost price, the purchase account) is neither shown to
// nor sent by a role that may not see costs: the server leaves those figures
// out, and saving must not overwrite them.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Combobox } from '@/components/ui/combobox';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { DocumentForm, FormRow } from '@/components/shared/form-layout';
import { ItemImageField } from '@/components/sales/item-image';
import { ContactPicker } from '@/components/forms/quick-create';
import { api, hsnCodes, items, type HsnCodeRow, type ItemRow } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { useCanSeeCosts, usePermission } from '@/lib/store/hooks';
import { useAppStore } from '@/lib/store';
import { GST_RATES, stateName } from '@/lib/tax/gst';
import { toRupees } from '@/lib/money';
import { cn } from '@/lib/utils';

/** The chart's default heads, by code (lib/server/ledger/chart-of-accounts.ts). */
const SALES = '4100';
const SERVICE_INCOME = '4200';
const PURCHASES = '5200';

/** The GST unit quantity codes, as Zoho's unit list offers its units. */
const UQC: [string, string][] = [
  ['NOS', 'Numbers'], ['PCS', 'Pieces'], ['SET', 'Sets'], ['PRS', 'Pairs'], ['BOX', 'Box'], ['PAC', 'Packs'], ['CTN', 'Cartons'],
  ['DOZ', 'Dozens'], ['KGS', 'Kilograms'], ['GMS', 'Grammes'], ['QTL', 'Quintal'], ['TON', 'Tonnes'], ['MTS', 'Metric ton'],
  ['LTR', 'Litres'], ['MLT', 'Millilitre'], ['KLR', 'Kilolitre'], ['MTR', 'Meters'], ['CMS', 'Centimeters'], ['KME', 'Kilometre'],
  ['SQF', 'Square feet'], ['SQM', 'Square meters'], ['SQY', 'Square yards'], ['CBM', 'Cubic meters'], ['CCM', 'Cubic centimeters'],
  ['YDS', 'Yards'], ['GYD', 'Gross yards'], ['BAG', 'Bags'], ['BAL', 'Bale'], ['BDL', 'Bundles'], ['BKL', 'Buckles'], ['BTL', 'Bottles'],
  ['BUN', 'Bunches'], ['CAN', 'Cans'], ['DRM', 'Drums'], ['ROL', 'Rolls'], ['TBS', 'Tablets'], ['TUB', 'Tubes'], ['UNT', 'Units'],
  ['GGK', 'Great gross'], ['GRS', 'Gross'], ['TGM', 'Ten gross'], ['THD', 'Thousands'], ['BOU', 'Billion of units'], ['UGS', 'US gallons'],
  ['OTH', 'Others'],
];

const BLANK = {
  name: '', sku: '', hsnSac: '', kind: 'goods' as 'goods' | 'service', origin: 'local' as 'local' | 'imported', description: '',
  uqc: 'NOS', salePrice: 0, purchasePrice: 0, gstRatePct: 18,
  taxPref: 'taxable' as 'taxable' | 'exempt' | 'nil' | 'non_gst',
  trackInventory: true,
  openingQty: '', openingRate: 0, trackBatches: false, trackSerials: false,
  mrp: 0, standardCost: 0, altUqc: '', altFactor: '', reorderLevel: '', minLevel: '',
  stockGroupId: '', valuationMethod: '' as '' | 'average' | 'fifo',
  // A kit: sold as a set, taking its components out of stock (services/kits.ts).
  isKit: false, kit: [] as { itemId: string; qty: number }[],
  // Zoho's fields.
  sell: true, buy: true, isDigitalService: false,
  upc: '', ean: '', isbn: '', mpn: '',
  purchaseDescription: '', saleAccountId: '', purchaseAccountId: '', preferredVendorId: '',
};
type FormState = typeof BLANK;

const TAX_PREFS = [
  { value: 'taxable', label: 'Taxable' },
  { value: 'exempt', label: 'Exempt' },
  { value: 'nil', label: 'Nil rated' },
  { value: 'non_gst', label: 'Non-GST supply' },
] as const;

/** A blank text box is "not set"; anything else has to be a number of zero or more. */
const qtyOrNull = (s: string): number | null | 'bad' => {
  if (!s.trim()) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : 'bad';
};
const digits = (s: string) => s.replace(/[^0-9.]/g, '');

/** The form filled from an item: to edit it, or (clone) to start a new one like it. */
function fromItem(r: ItemRow, clone: boolean): FormState {
  const s = (n: number | null) => (n === null ? '' : String(n));
  const type = r.itemType ?? 'sales_and_purchases';
  return {
    name: r.name, sku: clone ? '' : r.sku ?? '', hsnSac: r.hsnSac ?? '', kind: r.kind, uqc: r.uqc,
    origin: r.origin ?? 'local', description: r.description ?? '',
    salePrice: r.salePricePaise, purchasePrice: r.purchasePricePaise, gstRatePct: r.gstRatePct,
    taxPref: (['taxable', 'exempt', 'nil', 'non_gst'].includes(r.taxPref) ? r.taxPref : 'taxable') as FormState['taxPref'],
    trackInventory: r.trackInventory,
    // A clone starts with no stock of its own.
    openingQty: clone ? '' : s(r.openingStockQty), openingRate: clone ? 0 : r.openingStockRatePaise ?? 0,
    trackBatches: !!r.trackBatches, trackSerials: r.trackSerials,
    mrp: r.mrpPaise ?? 0, standardCost: r.standardCostPaise ?? 0,
    altUqc: r.altUqc ?? '', altFactor: s(r.altFactor), reorderLevel: s(r.reorderLevel), minLevel: s(r.minLevel),
    stockGroupId: r.stockGroupId ?? '', valuationMethod: r.valuationMethod ?? '',
    isKit: !!r.isKit, kit: r.kitComponents ?? [],
    sell: type !== 'purchases', buy: type !== 'sales', isDigitalService: !!r.isDigitalService,
    // Product codes are the piece's own: a clone starts without them.
    upc: clone ? '' : r.upc ?? '', ean: clone ? '' : r.ean ?? '', isbn: clone ? '' : r.isbn ?? '', mpn: r.mpn ?? '',
    purchaseDescription: r.purchaseDescription ?? '',
    saleAccountId: r.saleAccountId ?? '', purchaseAccountId: r.purchaseAccountId ?? '', preferredVendorId: r.preferredVendorId ?? '',
  };
}

/** Zoho's money box: the currency in a grey cell before the amount. */
function PriceInput({ valuePaise, onChangePaise, label, disabled }: { valuePaise: number; onChangePaise: (p: number) => void; label: string; disabled?: boolean }) {
  return (
    <div className={cn('flex h-[34px] w-full overflow-hidden rounded-[var(--radius-button)] border border-input bg-background focus-within:border-primary', disabled && 'opacity-60')}>
      <span className="grid shrink-0 place-items-center border-r border-input bg-[#f9f9fb] px-2.5 text-[13px] text-muted-foreground dark:bg-muted">INR</span>
      <input
        type="number" step="0.01" min="0" aria-label={label} disabled={disabled}
        className="min-w-0 flex-1 bg-transparent px-2.5 text-[13px] tabular outline-none"
        value={valuePaise === 0 ? '' : toRupees(valuePaise)}
        onChange={(e) => onChangePaise(Math.round(parseFloat(e.target.value || '0') * 100))}
      />
    </div>
  );
}

/** Zoho's radio pair: small round buttons with the word beside them. */
function Radios<T extends string>({ name, value, options, onChange, slot }: {
  name: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; slot?: string;
}) {
  return (
    <div className="flex h-[34px] flex-wrap items-center gap-x-6 gap-y-1" role="radiogroup" aria-label={name} data-slot={slot}>
      {options.map((o) => (
        <label key={o.value} className="flex cursor-pointer items-center gap-2 text-[13px]">
          <input type="radio" name={name} className="size-3.5 accent-primary" checked={value === o.value} onChange={() => onChange(o.value)} />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/** Zoho's section heading with its tick: "☑ Sales Information". */
function TickTitle({ checked, onChange, children, slot }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; slot: string }) {
  return (
    <label className="mb-4 flex cursor-pointer items-center gap-2.5 text-[15px] font-normal text-foreground">
      <input type="checkbox" className="size-3.5 accent-primary" checked={checked} onChange={(e) => onChange(e.target.checked)} data-slot={slot} />
      {children}
    </label>
  );
}

function SectionTitle({ children, extra }: { children: ReactNode; extra?: ReactNode }) {
  return <h3 className="mb-4 flex items-center gap-2 text-[15px] font-normal text-foreground">{children}{extra}</h3>;
}

const selectCls = 'h-[34px] w-full rounded-[var(--radius-button)] border border-input bg-background px-2 text-[13px] outline-none focus:border-primary';

interface TagList { tags: { id: string; name: string; isActive: boolean; options: { id: string; value: string; isActive: boolean }[] }[]; values?: Record<string, string> }

export function ItemForm({ editing, clone }: { editing?: ItemRow | null; clone?: ItemRow | null }) {
  const router = useRouter();
  const canSeeCosts = useCanSeeCosts();
  const canEdit = usePermission('sales', 'edit');
  const canAddCode = usePermission('settings', 'edit');
  const homeState = useAppStore((s) => s.branches.find((b) => b.id === s.activeBranchId)?.stateCode ?? '');
  const accounts = useAppStore((s) => s.accounts);
  const byCode = (code: string) => accounts.find((a) => a.code === code)?.id ?? '';
  const [form, setForm] = useState<FormState>(() => (editing ? fromItem(editing, false) : clone ? fromItem(clone, true) : BLANK));
  const [imageFileId, setImageFileId] = useState<string | null>(editing?.imageFileId ?? null);
  const [editRates, setEditRates] = useState(false);
  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));
  const goods = form.kind === 'goods';
  const back = editing ? `/sales/items/${editing.id}` : clone ? `/sales/items/${clone.id}` : '/sales/items';

  // A new item starts on Zoho's default heads: Sales (Service Income for a
  // service) and Purchases, once the chart has loaded.
  useEffect(() => {
    if (editing || !accounts.length) return;
    setForm((f) => ({
      ...f,
      saleAccountId: f.saleAccountId || byCode(f.kind === 'service' ? SERVICE_INCOME : SALES),
      purchaseAccountId: f.purchaseAccountId || byCode(PURCHASES),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.length, editing]);

  const codes = useApi<{ hsnCodes: HsnCodeRow[] }>(() => hsnCodes.list({ activeOnly: true }), []);
  const groups = useApi(() => api.get<{ groups: { id: string; name: string; parentId: string | null }[] }>('/api/stock-groups'), []);
  // The goods a kit can be made of: kept in stock, not kits themselves.
  const catalogue = useApi(() => items.list(), []);
  // Reporting tags, and the item's own (a clone takes its source's).
  const tagSource = editing?.id ?? clone?.id ?? null;
  const tagState = useApi<TagList>(
    () => api.get<TagList>('/api/reporting-tags', tagSource ? { entity: 'item', id: tagSource } : undefined),
    [tagSource],
  );
  const [tagValues, setTagValues] = useState<Record<string, string> | null>(null);
  const tags = (tagState.data?.tags ?? []).filter((t) => t.isActive);
  const tagValue = (tagId: string) => (tagValues ?? tagState.data?.values ?? {})[tagId] ?? '';

  const saleAccounts = useMemo(
    () => accounts.filter((a) => a.type === 'income' && !a.isArchived).sort((a, b) => a.code.localeCompare(b.code))
      .map((a) => ({ value: a.id, label: `[ ${a.code} ] ${a.name}` })),
    [accounts],
  );
  const purchaseAccounts = useMemo(
    () => accounts.filter((a) => (a.type === 'expense' || a.type === 'asset') && !a.isArchived).sort((a, b) => a.code.localeCompare(b.code))
      .map((a) => ({ value: a.id, label: `[ ${a.code} ] ${a.name}`, group: a.type === 'asset' ? 'Assets' : 'Expenses' })),
    [accounts],
  );
  const unitOptions = useMemo(() => {
    const known = UQC.map(([code, label]) => ({ value: code, label: code, sublabel: label }));
    return form.uqc && !UQC.some(([c]) => c === form.uqc) ? [{ value: form.uqc, label: form.uqc, sublabel: 'Your unit' }, ...known] : known;
  }, [form.uqc]);

  // A goods item takes an HSN, a service a SAC. Offering both invites the
  // classification error that puts a supply in the wrong GSTR-1 table.
  const codeOptions = useMemo(
    () =>
      (codes.data?.hsnCodes ?? [])
        .filter((h) => (form.kind === 'service' ? h.kind === 'sac' : h.kind === 'hsn'))
        .map((h) => ({ value: h.code, label: h.code, sublabel: h.description, meta: `${h.gstRatePct}%` })),
    [codes.data, form.kind],
  );

  const newGroup = async () => {
    const name = window.prompt('Name of the new stock group, such as Spares or Lubricants');
    if (!name?.trim()) return;
    try {
      const r = await api.post<{ id: string }>('/api/stock-groups', { name: name.trim() });
      await groups.refetch();
      set({ stockGroupId: r.id });
    } catch (e) {
      toast.error('Not added', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  // A code typed that is not on the approved list yet: its description and rate, to add it.
  const [newCode, setNewCode] = useState<{ code: string; description: string; gstRatePct: number } | null>(null);
  const [addingCode, setAddingCode] = useState(false);
  const addCode = async () => {
    if (!newCode) return;
    if (!/^\d{4,8}$/.test(newCode.code)) { toast.error('An HSN or SAC code is 4 to 8 digits.'); return; }
    if (!newCode.description.trim()) { toast.error('Describe what the code covers, as the GST tariff does.'); return; }
    setAddingCode(true);
    try {
      await hsnCodes.create({ code: newCode.code, description: newCode.description.trim(), gstRatePct: newCode.gstRatePct, uqc: goods ? form.uqc || null : null });
      await codes.refetch();
      set({ hsnSac: newCode.code, gstRatePct: newCode.gstRatePct, description: form.description || newCode.description.trim() });
      toast.success(`${newCode.code} added to the approved codes`, { description: 'Its rate and description are on the item.' });
      setNewCode(null);
    } catch (e) {
      toast.error('The code was not added', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setAddingCode(false);
    }
  };

  /** Goods ↔ service: the HSN goes, and the sales head and unit follow when still on their defaults. */
  const changeKind = (v: 'goods' | 'service') => {
    if (v === form.kind) return;
    const fromDefault = form.saleAccountId === byCode(form.kind === 'service' ? SERVICE_INCOME : SALES);
    set({
      kind: v, hsnSac: '',
      uqc: v === 'service' && form.uqc === 'NOS' ? 'OTH' : v === 'goods' && form.uqc === 'OTH' ? 'NOS' : form.uqc,
      ...(fromDefault || !form.saleAccountId ? { saleAccountId: byCode(v === 'service' ? SERVICE_INCOME : SALES) } : {}),
      ...(v === 'goods' ? { isDigitalService: false } : {}),
    });
  };

  const create = useApiAction(items.create);
  const update = useApiAction(items.update);
  const action = editing ? update : create;

  const save = async () => {
    if (!form.name.trim()) { toast.error('Item name is required'); return; }
    if (!form.sell && !form.buy) { toast.error('Tick Sales Information, Purchase Information or both: an item is sold, bought, or both.'); return; }
    if (form.sell && !form.saleAccountId) { toast.error('Choose the account its sales go to.'); return; }
    // Goods keep their stock figures as they were read, shown or not: an
    // untracked item's levels are not cleared by saving its name.
    const openingQty = goods ? qtyOrNull(form.openingQty) : null;
    const reorderLevel = goods ? qtyOrNull(form.reorderLevel) : null;
    const minLevel = goods ? qtyOrNull(form.minLevel) : null;
    const altFactor = goods && form.altUqc.trim() ? qtyOrNull(form.altFactor) : null;
    if ([openingQty, reorderLevel, minLevel, altFactor].includes('bad')) {
      toast.error('Quantities are numbers of zero or more.');
      return;
    }
    const kit = form.isKit ? form.kit.filter((k) => k.itemId && k.qty > 0) : [];
    if (form.isKit && !kit.length) { toast.error('A kit needs its components: pick each item and how many.'); return; }
    const payload: Record<string, unknown> = {
      kind: form.kind,
      name: form.name.trim(),
      sku: form.sku || null,
      hsnSac: form.hsnSac || null,
      description: form.description.trim() || null,
      origin: form.origin,
      uqc: form.uqc || 'NOS',
      salePricePaise: form.sell ? form.salePrice : 0,
      gstRatePct: form.gstRatePct,
      taxPref: form.taxPref,
      itemType: form.sell && form.buy ? 'sales_and_purchases' : form.sell ? 'sales' : 'purchases',
      isDigitalService: !goods && form.isDigitalService,
      upc: form.upc.trim() || null,
      ean: form.ean.trim() || null,
      isbn: form.isbn.trim() || null,
      mpn: form.mpn.trim() || null,
      saleAccountId: form.saleAccountId || null,
      // Tracking is chosen once, when the item is made; an edit leaves it as it was.
      ...(editing ? {} : { trackInventory: goods && form.trackInventory }),
      trackBatches: goods && form.trackBatches,
      trackSerials: goods && form.trackSerials,
      openingStockQty: openingQty,
      mrpPaise: goods && form.mrp > 0 ? form.mrp : null,
      altUqc: goods && form.altUqc.trim() ? form.altUqc.trim().toUpperCase() : null,
      altFactor,
      reorderLevel,
      minLevel,
      stockGroupId: goods && form.stockGroupId ? form.stockGroupId : null,
      valuationMethod: goods && form.valuationMethod ? form.valuationMethod : null,
      // Sent when it is a kit, or was one: an empty list makes it an ordinary item again.
      ...(goods && (form.isKit || editing?.isKit) ? { kitComponents: kit.map((k) => ({ itemId: k.itemId, qty: k.qty })) } : {}),
    };
    if (canSeeCosts) {
      payload.purchasePricePaise = form.buy ? form.purchasePrice : 0;
      payload.purchaseAccountId = form.purchaseAccountId || null;
      payload.purchaseDescription = form.purchaseDescription.trim() || null;
      payload.preferredVendorId = form.preferredVendorId || null;
      payload.standardCostPaise = goods && form.standardCost > 0 ? form.standardCost : null;
      // Left blank, the opening stock is carried at the purchase price.
      payload.openingStockRatePaise = openingQty !== null && form.openingRate > 0 ? form.openingRate : null;
    }
    const result = editing
      ? await update.run({ ...payload, id: editing.id, expectedUpdatedAt: editing.updatedAt })
      : await create.run(payload);
    if (!result) return;
    // The tags go on once the item exists: every one chosen (an edit's as read,
    // unless changed; a clone's from its source), and on an edit the ones cleared.
    const chosen = tagValues ?? tagState.data?.values ?? {};
    const values = Object.fromEntries(tags.map((t) => [t.id, chosen[t.id] || null]).filter(([, v]) => v || editing));
    if (Object.keys(values).length) {
      try {
        await api.post('/api/reporting-tags', { action: 'assign', entity: 'item', id: result.id, values });
      } catch (e) {
        toast.error('The item is saved; its tags were not', { description: e instanceof Error ? e.message : String(e) });
      }
    }
    toast.success(editing ? `${payload.name} saved` : `${payload.name} added`);
    router.push(`/sales/items/${result.id}`);
  };

  const tracked = goods && (editing ? editing.trackInventory : form.trackInventory);
  const field = action.fieldErrors;

  return (
    <DocumentForm
      title={editing ? 'Edit Item' : 'New Item'}
      backHref={back}
      footer={
        <>
          <Button onClick={() => void save()} disabled={action.busy} data-slot="item-save">{action.busy ? 'Saving…' : 'Save'}</Button>
          <Button variant="outline" asChild><Link href={back}>Cancel</Link></Button>
          {action.error && <span className="text-[13px] text-destructive" data-slot="item-error">{action.error}</span>}
        </>
      }
    >
      {/* The grey band: what the item is. It runs to the window's right edge, as Zoho's does. */}
      <section data-slot="item-basics" className="-mx-5 -mt-7 bg-[#fbfbfb] px-5 py-7 shadow-[0_0_0_100vmax_#fbfbfb] [clip-path:inset(0_-100vmax_0_0)] dark:bg-muted dark:shadow-[0_0_0_100vmax_var(--muted)]">
        <div className="flex flex-col gap-8 lg:flex-row">
          <div className="min-w-0 max-w-[560px] flex-1 space-y-4">
            <FormRow label="Type" help="Goods are things you hold and ship: they carry an HSN code and can be kept in stock. A service is work you do: it carries a SAC.">
              <Radios
                name="Goods or service" slot="item-kind" value={form.kind}
                options={[{ value: 'goods', label: 'Goods' }, { value: 'service', label: 'Service' }]}
                onChange={changeKind}
              />
            </FormRow>
            <FormRow label="Name" required error={field.name} htmlFor="item-name">
              <Input id="item-name" value={form.name} onChange={(e) => set({ name: e.target.value })} autoFocus={!editing} />
            </FormRow>
            <FormRow label="SKU" error={field.sku} htmlFor="item-sku" help="The Stock Keeping Unit of the item: your own code for it, unique in your books.">
              <Input id="item-sku" value={form.sku} onChange={(e) => set({ sku: e.target.value })} />
            </FormRow>
            <FormRow label="Unit" hint="The unit quantity code GST returns use" help="The item will be measured in terms of this unit (e.g.: NOS, KGS, BOX).">
              <Combobox
                options={unitOptions}
                value={form.uqc}
                onChange={(v) => set({ uqc: v })}
                createLabel="Use this unit"
                onCreate={(q) => set({ uqc: q.trim().toUpperCase().slice(0, 10) })}
                placeholder="Select or type to add"
                searchPlaceholder="Search units"
                showAvatar={false}
              />
            </FormRow>
            {!goods && (
              <div className="sm:pl-[180px]">
                <label className="flex items-center gap-2 text-[13px]">
                  <input type="checkbox" className="size-3.5 accent-primary" checked={form.isDigitalService} onChange={(e) => set({ isDigitalService: e.target.checked })} data-slot="digital-service" />
                  It is a digital service
                  <span className="text-[12px] text-muted-foreground">(online information and database access or retrieval)</span>
                </label>
              </div>
            )}
            <FormRow label={goods ? 'HSN Code' : 'SAC'} hint="Fills the GST rate, unit and description" error={field.hsnSac}>
              <Combobox
                options={codeOptions}
                value={form.hsnSac}
                onChange={(v) => {
                  const picked = codes.data?.hsnCodes.find((h) => h.code === v);
                  set({
                    hsnSac: v,
                    gstRatePct: picked ? picked.gstRatePct : form.gstRatePct,
                    uqc: picked?.uqc || form.uqc,
                    description: form.description.trim() ? form.description : picked?.description ?? '',
                  });
                }}
                createLabel={goods ? 'Add this HSN code' : 'Add this SAC code'}
                onCreate={(q) => setNewCode({ code: q.replace(/\D/g, '').slice(0, 8), description: '', gstRatePct: form.gstRatePct })}
                placeholder={goods ? 'Type 8 for 8xxx…' : 'Type 99…'}
                searchPlaceholder="Type the first digits"
                matchMode="prefix"
                showAvatar={false}
                clearable
              />
            </FormRow>
            {newCode && (
              <div className="space-y-2 rounded-[var(--radius-button)] border border-primary/40 bg-primary/5 p-3 sm:ml-[180px]" data-slot="new-hsn">
                <p className="text-[13px] font-medium">{newCode.code || 'This code'} is not on the approved list yet</p>
                {canAddCode ? (
                  <>
                    <div className="grid gap-2 sm:grid-cols-[110px_1fr_100px]">
                      <Input value={newCode.code} onChange={(e) => setNewCode({ ...newCode, code: e.target.value.replace(/\D/g, '').slice(0, 8) })} placeholder="Code" className="font-mono" aria-label="HSN or SAC code" />
                      <Input value={newCode.description} onChange={(e) => setNewCode({ ...newCode, description: e.target.value })} placeholder="What it covers, as in the GST tariff" aria-label="Code description" />
                      <select value={String(newCode.gstRatePct)} onChange={(e) => setNewCode({ ...newCode, gstRatePct: Number(e.target.value) })} aria-label="GST rate of the code" className={selectCls}>
                        {GST_RATES.map((r) => <option key={r} value={r}>{r}%</option>)}
                      </select>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => void addCode()} disabled={addingCode}>{addingCode ? 'Adding…' : 'Add to approved codes'}</Button>
                      <Button size="sm" variant="ghost" onClick={() => setNewCode(null)}>Cancel</Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">Check the rate against the GST rate schedule: GSTR-1 is validated against it.</p>
                  </>
                ) : (
                  <p className="text-[12px] text-muted-foreground">Ask an admin to add it under Settings → HSN codes; only approved codes reach the GST return.</p>
                )}
              </div>
            )}
            <FormRow label="Tax Preference" required>
              <Select value={form.taxPref} onValueChange={(v) => set({ taxPref: v as FormState['taxPref'] })}>
                <SelectTrigger aria-label="Tax Preference"><SelectValue>{TAX_PREFS.find((t) => t.value === form.taxPref)?.label}</SelectValue></SelectTrigger>
                <SelectContent>
                  {TAX_PREFS.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </FormRow>
            <FormRow label={goods ? 'Comes from' : 'Provided from'}>
              <Radios
                name="Local or imported" slot="item-origin" value={form.origin}
                options={goods
                  ? [{ value: 'local', label: 'Local' }, { value: 'imported', label: 'Imported' }]
                  : [{ value: 'local', label: 'From India' }, { value: 'imported', label: 'From abroad' }]}
                onChange={(v) => set({ origin: v })}
              />
            </FormRow>
          </div>
          <div className="shrink-0 space-y-6 lg:w-[300px]">
            <div data-slot="item-picture">
              <p className="mb-2 text-[13px] text-field-label">Picture</p>
              <ItemImageField
                itemId={editing?.id ?? null} fileId={imageFileId} name={form.name || 'Item'} canEdit={canEdit}
                onChanged={setImageFileId}
              />
            </div>
            {/* Zoho's product codes, beside the SKU. */}
            <div className="grid grid-cols-2 gap-3" data-slot="item-codes">
              {([['upc', 'UPC', 20], ['mpn', 'MPN', 40], ['ean', 'EAN', 20], ['isbn', 'ISBN', 20]] as const).map(([k, label, max]) => (
                <label key={k} className="space-y-1 text-[13px] text-field-label">
                  <span>{label}</span>
                  <Input value={form[k]} onChange={(e) => set({ [k]: e.target.value } as Partial<FormState>)} maxLength={max} aria-label={label} className="font-mono" />
                </label>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Sales and purchase, side by side, each with its tick. */}
      <div className="grid gap-10 lg:grid-cols-2">
        <section data-slot="item-sales">
          <TickTitle checked={form.sell} onChange={(v) => set({ sell: v })} slot="item-sell">Sales Information</TickTitle>
          <div className={cn('space-y-4', !form.sell && 'pointer-events-none opacity-50')}>
            <FormRow label="Selling Price" required={form.sell} error={field.salePricePaise} help="The rate at which you sell this item: it fills the line on invoices and quotes.">
              <PriceInput label="Selling Price" valuePaise={form.salePrice} onChangePaise={(p) => set({ salePrice: p })} disabled={!form.sell} />
            </FormRow>
            <FormRow label="Account" required={form.sell} help="Every sale of this item is posted to this income account.">
              <Combobox
                options={saleAccounts}
                value={form.saleAccountId}
                onChange={(v) => set({ saleAccountId: v })}
                placeholder="Select an account"
                searchPlaceholder="Search income accounts"
                showAvatar={false}
                disabled={!form.sell}
              />
            </FormRow>
            <FormRow label="Description" hint="Printed under the item on invoices and quotes">
              <Textarea value={form.description} onChange={(e) => set({ description: e.target.value })} rows={2} aria-label="Description" disabled={!form.sell} />
            </FormRow>
            {goods && (
              <FormRow label="MRP" hint="Printed on the pack. A sale above it is flagged.">
                <PriceInput label="MRP" valuePaise={form.mrp} onChangePaise={(p) => set({ mrp: p })} disabled={!form.sell} />
              </FormRow>
            )}
          </div>
        </section>
        {canSeeCosts && (
          <section data-slot="item-purchase">
            <TickTitle checked={form.buy} onChange={(v) => set({ buy: v })} slot="item-buy">Purchase Information</TickTitle>
            <div className={cn('space-y-4', !form.buy && 'pointer-events-none opacity-50')}>
              <FormRow label="Cost Price" required={form.buy} help="The rate at which you buy this item: it fills the line on bills and purchase orders.">
                <PriceInput label="Cost Price" valuePaise={form.purchasePrice} onChangePaise={(p) => set({ purchasePrice: p })} disabled={!form.buy} />
              </FormRow>
              <FormRow label="Account" required={form.buy} help="Every purchase of this item is posted to this account.">
                <Combobox
                  options={purchaseAccounts}
                  value={form.purchaseAccountId}
                  onChange={(v) => set({ purchaseAccountId: v })}
                  placeholder="Select an account"
                  searchPlaceholder="Search expense and asset accounts"
                  showAvatar={false}
                  disabled={!form.buy}
                />
              </FormRow>
              <FormRow label="Description" hint="What a bill or purchase order line says">
                <Textarea value={form.purchaseDescription} onChange={(e) => set({ purchaseDescription: e.target.value })} rows={2} aria-label="Purchase Description" disabled={!form.buy} />
              </FormRow>
              <FormRow label="Preferred Vendor">
                <ContactPicker kind="vendor" value={form.preferredVendorId} onChange={(v) => set({ preferredVendorId: v })} canCreate={false} disabled={!form.buy} />
              </FormRow>
              {goods && (
                <FormRow label="Standard cost" hint="Budgeted cost a unit, set against the actual.">
                  <PriceInput label="Standard cost" valuePaise={form.standardCost} onChangePaise={(p) => set({ standardCost: p })} disabled={!form.buy} />
                </FormRow>
              )}
            </div>
          </section>
        )}
      </div>

      {/* GST: one rate, CGST + SGST within the state and IGST across states. Read-only until the pencil. */}
      {form.taxPref === 'taxable' && (
        <section className="border-t pt-6" data-slot="item-tax-rates">
          <SectionTitle extra={(
            <button type="button" onClick={() => setEditRates((v) => !v)} aria-label="Edit the default tax rates" data-slot="edit-tax-rates"
              className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground">
              <Pencil className="size-3.5" />
            </button>
          )}>Default Tax Rates</SectionTitle>
          <div className="grid gap-10 lg:grid-cols-2">
            <div className="space-y-4">
              <FormRow label="Intra State Tax Rate" help="Charged as CGST and SGST, half each, when the place of supply is your own state.">
                {editRates ? (
                  <Select value={String(form.gstRatePct)} onValueChange={(v) => set({ gstRatePct: Number(v) })}>
                    <SelectTrigger aria-label="GST rate"><SelectValue>{`GST${form.gstRatePct} (${form.gstRatePct} %)`}</SelectValue></SelectTrigger>
                    <SelectContent>
                      {GST_RATES.map((r) => <SelectItem key={r} value={String(r)}>{`GST${r} (${r} %)`}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="pt-[7px] text-[13px]" data-slot="gst-rate">{`GST${form.gstRatePct} (${form.gstRatePct} %)`}</p>
                )}
              </FormRow>
              <FormRow label="Inter State Tax Rate" help="Charged as IGST when the place of supply is another state, or the supply is an export.">
                <p className="pt-[7px] text-[13px]" data-slot="igst-rate">{`IGST${form.gstRatePct} (${form.gstRatePct} %)`}</p>
              </FormRow>
            </div>
            <div className="space-y-1.5 rounded-[var(--radius-button)] border bg-muted/40 p-3 text-[12px]" data-slot="gst-preview">
              <p className="font-semibold">How GST falls on it at {form.gstRatePct}%</p>
              <p><span className="text-muted-foreground">Sold within {homeState ? stateName(homeState) : 'your state'}:</span> CGST {form.gstRatePct / 2}% + SGST {form.gstRatePct / 2}%</p>
              <p><span className="text-muted-foreground">Sold to another state:</span> IGST {form.gstRatePct}%</p>
              <p><span className="text-muted-foreground">Exported:</span> zero-rated under your LUT, or IGST {form.gstRatePct}% refunded</p>
              {form.origin === 'imported' ? (
                <p data-slot="import-note"><span className="text-muted-foreground">{goods ? 'Imported:' : 'From abroad:'}</span>{' '}
                  {goods
                    ? `IGST ${form.gstRatePct}% paid at customs on the Bill of Entry, with the customs duty; claimed back as input credit`
                    : `IGST ${form.gstRatePct}% paid by you under reverse charge, and claimed back as input credit`}
                </p>
              ) : (
                <p><span className="text-muted-foreground">Bought:</span> CGST + SGST from a supplier in your state, IGST from another state</p>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Stock: Zoho's "Track Inventory for this item", and what Rekonza keeps with it. */}
      {goods && (
        <section className="space-y-5 border-t pt-6" data-slot="item-stock">
          <label className="flex items-start gap-2 text-[14px]">
            <input
              type="checkbox" className="mt-1 size-3.5 accent-primary"
              checked={tracked} disabled={!!editing}
              onChange={(e) => set({ trackInventory: e.target.checked })}
              data-slot="track-inventory"
            />
            <span>
              Track Inventory for this item
              <span className="block text-[12px] text-muted-foreground">
                {editing ? 'Stock tracking is chosen when the item is made, and stays as it was.' : 'You cannot turn inventory tracking on or off once the item is made.'}
              </span>
            </span>
          </label>
          {tracked && (
            <div className="grid gap-x-10 gap-y-4 lg:grid-cols-2">
              <FormRow label="Opening Stock" hint="Quantity on hand when your books begin">
                <Input value={form.openingQty} onChange={(e) => set({ openingQty: digits(e.target.value) })} placeholder="0" inputMode="decimal" className="tabular" aria-label="Opening Stock" />
              </FormRow>
              {canSeeCosts && (
                <FormRow label="Opening Stock Rate per Unit" hint="Blank uses the cost price.">
                  <PriceInput label="Opening Stock Rate per Unit" valuePaise={form.openingRate} onChangePaise={(p) => set({ openingRate: p })} />
                </FormRow>
              )}
              <FormRow label="Reorder Point" hint="Time to buy at or below this">
                <Input value={form.reorderLevel} onChange={(e) => set({ reorderLevel: digits(e.target.value) })} placeholder="0" inputMode="decimal" className="tabular" aria-label="Reorder Point" />
              </FormRow>
              <FormRow label="Minimum level" hint="Short at or below this">
                <Input value={form.minLevel} onChange={(e) => set({ minLevel: digits(e.target.value) })} placeholder="0" inputMode="decimal" className="tabular" aria-label="Minimum level" />
              </FormRow>
              <FormRow label="Stock group">
                <select value={form.stockGroupId} onChange={(e) => (e.target.value === '__new' ? void newGroup() : set({ stockGroupId: e.target.value }))} className={selectCls} aria-label="Stock group">
                  <option value="">None</option>
                  {(groups.data?.groups ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  <option value="__new">+ New group…</option>
                </select>
              </FormRow>
              <FormRow label="Valued by" hint="For closing stock">
                <select value={form.valuationMethod} onChange={(e) => set({ valuationMethod: e.target.value as FormState['valuationMethod'] })} className={selectCls} aria-label="Valued by">
                  <option value="">The book&apos;s method</option>
                  <option value="average">Weighted average</option>
                  <option value="fifo">First in, first out</option>
                </select>
              </FormRow>
              <label className="flex items-start gap-2 text-[13px] lg:col-span-2">
                <input type="checkbox" className="mt-1 size-3.5 accent-primary" checked={form.trackBatches} onChange={(e) => set({ trackBatches: e.target.checked })} />
                <span>Track batches and expiry<span className="block text-[12px] text-muted-foreground">Each purchase names its batch and expiry; sales take the earliest to expire first. Opening stock is then entered as an adjustment, batch by batch.</span></span>
              </label>
              <label className="flex items-start gap-2 text-[13px] lg:col-span-2">
                <input type="checkbox" className="mt-1 size-3.5 accent-primary" checked={form.trackSerials} onChange={(e) => set({ trackSerials: e.target.checked })} />
                <span>Track serial numbers<span className="block text-[12px] text-muted-foreground">Each piece is named by its number as it is bought and sold, so any one can be traced for warranty or service. Pieces already on hand are entered as an adjustment, with their numbers.</span></span>
              </label>
            </div>
          )}
          <div className="grid gap-x-10 gap-y-4 lg:grid-cols-2">
            <FormRow label="Second unit" hint="Bought or counted in, e.g. BOX">
              <Input value={form.altUqc} onChange={(e) => set({ altUqc: e.target.value.toUpperCase() })} placeholder="BOX" maxLength={10} aria-label="Second unit" />
            </FormRow>
            <FormRow label={`${form.uqc || 'Units'} in one ${form.altUqc || 'second unit'}`}>
              <Input value={form.altFactor} onChange={(e) => set({ altFactor: digits(e.target.value) })} placeholder="12" inputMode="decimal" className="tabular" disabled={!form.altUqc.trim()} aria-label="Units in the second unit" />
            </FormRow>
          </div>

          <div className="space-y-3 rounded-[var(--radius-button)] border p-3" data-slot="kit-editor">
            <label className="flex items-start gap-2 text-[13px]">
              <input type="checkbox" className="mt-1 size-3.5 accent-primary" checked={form.isKit} onChange={(e) => set({ isKit: e.target.checked, kit: e.target.checked && !form.kit.length ? [{ itemId: '', qty: 1 }] : form.kit })} />
              <span>Sold as a kit<span className="block text-[12px] text-muted-foreground">It holds no stock of its own: each sale takes the components below out of stock, and a return puts them back.</span></span>
            </label>
            {form.isKit && (
              <div className="space-y-2">
                {form.kit.map((k, i) => (
                  <div key={i} className="grid grid-cols-[1fr_90px_auto] gap-2">
                    <select value={k.itemId} onChange={(e) => set({ kit: form.kit.map((x, j) => (j === i ? { ...x, itemId: e.target.value } : x)) })} className={selectCls} aria-label="Component">
                      <option value="">Pick a component</option>
                      {(catalogue.data?.items ?? []).filter((x) => x.kind === 'goods' && x.trackInventory && !x.isKit && x.id !== editing?.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                    <Input type="number" min={0} step="0.001" value={k.qty} onChange={(e) => set({ kit: form.kit.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) || 0 } : x)) })} aria-label="Quantity in the kit" />
                    <Button size="sm" variant="ghost" onClick={() => set({ kit: form.kit.filter((_, j) => j !== i) })}>Remove</Button>
                  </div>
                ))}
                <Button size="sm" variant="outline" onClick={() => set({ kit: [...form.kit, { itemId: '', qty: 1 }] })}>Add a component</Button>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Zoho's "Associate Tags": a value of each reporting tag the book keeps. */}
      <section className="border-t pt-6" data-slot="item-tags">
        <SectionTitle>Associate Tags</SectionTitle>
        {tags.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No reporting tags yet. An admin adds them under Settings → Reporting tags.</p>
        ) : (
          <div className="grid gap-x-10 gap-y-4 lg:grid-cols-2">
            {tags.map((t) => (
              <FormRow key={t.id} label={t.name}>
                <select
                  value={tagValue(t.id)} aria-label={t.name} className={selectCls} data-slot="item-tag"
                  onChange={(e) => setTagValues({ ...(tagValues ?? tagState.data?.values ?? {}), [t.id]: e.target.value })}
                >
                  <option value="">None</option>
                  {t.options.filter((o) => o.isActive || o.id === tagValue(t.id)).map((o) => <option key={o.id} value={o.id}>{o.value}</option>)}
                </select>
              </FormRow>
            ))}
          </div>
        )}
      </section>
    </DocumentForm>
  );
}
