'use client';

// The new-document dialog shared by estimates, orders, challans and credit
// notes.
//
// All four ask the same questions — customer, then the lines: item, quantity,
// rate, discount — and differ only in the one extra field their kind needs: a
// validity date, a ship date, a purpose, a reason. Four near-identical dialogs
// would drift.
//
// Several lines, and several items picked in one go, so an order for ten parts
// is one dialog rather than ten. An estimate or order can carry an offer: a
// discount percentage applied to every line, printed with each. The items
// offered are the ones the customer buys (goods, services or both).

import { useMemo, useState, type ReactNode } from 'react';
import { ListPlus, Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import { ContactPicker, QuickItemDialog } from '@/components/forms/quick-create';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { Money } from '@/components/shared/money';
import { salesDocuments, type SalesDocKind } from '@/lib/api/client';
import { VoucherTypePicker, type VoucherDocType } from '@/components/forms/voucher-type-picker';
import { useApiAction } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { itemOptionsFor } from '@/lib/options';
import { formatINR } from '@/lib/money';
import { cn } from '@/lib/utils';

const DOC_TYPE: Record<string, VoucherDocType> = { estimate: 'EST', 'sales-order': 'SO', challan: 'DC', 'credit-note': 'CN' };

/** yyyy-mm-dd, n days from today. */
function inDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

const TODAY = () => new Date().toISOString().slice(0, 10);

interface Line { key: number; itemId: string; qty: number; rate: number; discountPct: number; gstRatePct: number }
let nextKey = 1;
const blankLine = (): Line => ({ key: nextKey++, itemId: '', qty: 1, rate: 0, discountPct: 0, gstRatePct: 18 });

/** A line's figures, as the server works them: discount off the rate, GST on what is left. */
function figures(l: Line) {
  const gross = Math.round(l.rate * l.qty);
  const taxable = Math.round(gross * (1 - l.discountPct / 100));
  const tax = Math.round((taxable * l.gstRatePct) / 100);
  return { gross, discount: gross - taxable, taxable, tax, total: taxable + tax };
}

export function QuickDocumentDialog({
  kind,
  title,
  description,
  buttonLabel,
  extra,
  onCreated,
}: {
  kind: SalesDocKind;
  title: string;
  description: string;
  buttonLabel: string;
  /** Renders the one field this kind needs beyond the shared ones. */
  extra?: (value: string, set: (v: string) => void) => ReactNode;
  onCreated: () => void;
}) {
  // Items and the active branch come from the store, which is hydrated from
  // /api/masters — the same ids the server will validate against. Customers
  // come from ContactPicker, which reads the same store and can add one.
  const branchId = useAppStore((s) => s.activeBranchId);
  const store = useAppStore((s) => s);
  const items = store.items;

  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [lines, setLines] = useState<Line[]>(() => [blankLine()]);
  // Non-null while the inline "New item" dialog is open, for that line.
  const [newItem, setNewItem] = useState<{ name: string; key: number } | null>(null);
  const [picking, setPicking] = useState(false);
  const [offerPct, setOfferPct] = useState('');
  const [extraValue, setExtraValue] = useState('');
  const [voucherTypeId, setVoucherTypeId] = useState('');

  const create = useApiAction(salesDocuments.create);
  // A challan carries no tax, and neither does a business not registered for GST, or on composition.
  const chargesGst = !['unregistered', 'composition'].includes(store.org?.gstRegistrationType ?? 'regular');
  const taxed = kind !== 'challan' && chargesGst;
  const offers = kind === 'estimate' || kind === 'sales-order';

  // What the customer buys decides the items offered.
  const supplies = store.contacts.find((c) => c.id === customerId)?.supplies ?? 'both';
  const itemChoices = useMemo(() => itemOptionsFor(store as never, supplies), [store, supplies]);
  const allowed = useMemo(() => new Set(itemChoices.map((o) => o.value)), [itemChoices]);

  const totals = useMemo(() => lines.filter((l) => l.itemId).map(figures).reduce(
    (t, f) => ({ gross: t.gross + f.gross, discount: t.discount + f.discount, taxable: t.taxable + f.taxable, tax: t.tax + f.tax, total: t.total + f.total }),
    { gross: 0, discount: 0, taxable: 0, tax: 0, total: 0 },
  ), [lines]);

  const reset = () => {
    setCustomerId('');
    setLines([blankLine()]);
    setOfferPct('');
    setExtraValue('');
    setVoucherTypeId('');
    create.reset();
  };

  const offer = Math.min(100, Math.max(0, Number(offerPct) || 0));
  const fromItem = (l: Line, itemId: string): Line => {
    const picked = items.find((i) => i.id === itemId);
    return { ...l, itemId, rate: picked?.salePricePaise ?? 0, gstRatePct: picked?.gstRatePct ?? 18, discountPct: l.discountPct || offer };
  };
  const setLine = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const pickItem = (key: number, itemId: string) => setLines((ls) => ls.map((l) => (l.key === key ? fromItem(l, itemId) : l)));
  /** Several items at once: each a line, filling the empty one first. */
  const addItems = (ids: string[]) => setLines((ls) => {
    const kept = ls.filter((l) => l.itemId);
    return [...kept, ...ids.map((id) => fromItem(blankLine(), id))];
  });
  const applyOffer = (pct: string) => {
    setOfferPct(pct);
    const p = Math.min(100, Math.max(0, Number(pct) || 0));
    setLines((ls) => ls.map((l) => ({ ...l, discountPct: p })));
  };

  const save = async () => {
    const filled = lines.filter((l) => l.itemId);
    if (!customerId || !filled.length) {
      toast.error('Pick a customer and at least one item.');
      return;
    }
    if (filled.some((l) => !allowed.has(l.itemId))) {
      toast.error('A line has an item this customer does not buy. Change the item, or what they buy on the customer.');
      return;
    }

    const base = {
      kind,
      branchId,
      customerId,
      date: TODAY(),
      lines: filled.map((l) => ({
        itemId: l.itemId, qty: l.qty, ratePaise: l.rate,
        ...(kind !== 'challan' ? { gstRatePct: l.gstRatePct } : {}),
        ...(l.discountPct > 0 ? { discountPct: l.discountPct } : {}),
      })),
      voucherTypeId: voucherTypeId || null,
    };

    const payload =
      kind === 'estimate' ? { ...base, expiryDate: extraValue || inDays(15), status: 'sent' as const }
      : kind === 'sales-order' ? { ...base, expectedShipDate: extraValue || inDays(14) }
      : kind === 'challan' ? { ...base, challanType: extraValue || 'other' }
      : { ...base, reason: extraValue };

    if (kind === 'credit-note' && !extraValue.trim()) {
      toast.error('A credit note needs a reason — it is reported in GSTR-1.');
      return;
    }

    const result = await create.run(payload);
    if (!result) return;

    toast.success(`${result.number} created`, {
      description:
        result.journalEntryId
          ? 'Posted to the ledger.'
          : 'Nothing posts to the ledger — no sale has happened yet.',
    });
    setOpen(false);
    reset();
    onCreated();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5"><Plus className="size-4" /> {buttonLabel}</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-5xl" data-slot={`new-${kind}`}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1 thin-scroll">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Customer" required error={create.fieldErrors.customerId} className="sm:col-span-2">
              <ContactPicker kind="customer" value={customerId} onChange={setCustomerId} />
            </Field>
            {extra?.(extraValue, setExtraValue)}
            <div className="sm:col-span-3">
              <VoucherTypePicker docType={DOC_TYPE[kind]} ordinary={`Ordinary ${DOC_TYPE[kind]} series`} value={voucherTypeId} onChange={setVoucherTypeId} />
            </div>
          </div>
          {supplies !== 'both' && (
            <p className="text-xs text-muted-foreground">This customer buys {supplies === 'goods' ? 'goods' : 'services'} only, so only those items are offered.</p>
          )}

          <div className="overflow-x-auto rounded-md border" data-slot="quick-lines">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-2 py-2 text-left font-medium">Item</th>
                  <th className="w-20 px-2 py-2 text-right font-medium">Qty</th>
                  <th className="w-36 px-2 py-2 text-right font-medium">Rate</th>
                  {kind !== 'challan' && <th className="w-24 px-2 py-2 text-right font-medium">Discount %</th>}
                  {taxed && <th className="w-20 px-2 py-2 text-right font-medium">GST %</th>}
                  <th className="w-32 px-2 py-2 text-right font-medium">Amount</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const f = figures(l);
                  return (
                    <tr key={l.key} className="border-t align-top" data-slot="quick-line">
                      <td className="px-2 py-1.5">
                        <Combobox
                          options={itemChoices}
                          value={l.itemId}
                          onChange={(v) => pickItem(l.key, v)}
                          placeholder="Select an item"
                          searchPlaceholder="Search items by name, SKU or HSN"
                          showAvatar={false}
                          createLabel="New item"
                          onCreate={(q) => setNewItem({ name: q, key: l.key })}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input type="number" min="0" step="any" aria-label={`Quantity, line ${i + 1}`} className="text-right tabular"
                          value={l.qty} onChange={(e) => setLine(l.key, { qty: Math.max(0, Number(e.target.value) || 0) })} />
                      </td>
                      <td className="px-2 py-1.5"><MoneyInput valuePaise={l.rate} onChangePaise={(p) => setLine(l.key, { rate: p })} /></td>
                      {kind !== 'challan' && (
                        <td className="px-2 py-1.5">
                          <Input type="number" min="0" max="100" step="any" aria-label={`Discount, line ${i + 1}`} className="text-right tabular"
                            value={l.discountPct || ''} placeholder="0"
                            onChange={(e) => setLine(l.key, { discountPct: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} />
                        </td>
                      )}
                      {taxed && (
                        <td className="px-2 py-1.5">
                          <Input type="number" min="0" step="any" aria-label={`GST rate, line ${i + 1}`} className="text-right tabular"
                            value={l.gstRatePct} onChange={(e) => setLine(l.key, { gstRatePct: Math.max(0, Number(e.target.value) || 0) })} />
                        </td>
                      )}
                      <td className="px-2 py-2.5 text-right tabular">
                        <Money value={taxed ? f.total : f.taxable} />
                        {f.discount > 0 && <p className="text-[11px] text-emerald-700 dark:text-emerald-400">−{formatINR(f.discount)} off</p>}
                      </td>
                      <td className="px-1 py-1.5">
                        <Button variant="ghost" size="icon-sm" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1 && !l.itemId}
                          onClick={() => setLines((ls) => (ls.length === 1 ? [blankLine()] : ls.filter((x) => x.key !== l.key)))}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setLines((ls) => [...ls, blankLine()])}>
                <Plus className="size-3.5" /> Add a line
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setPicking(true)} data-slot="add-several">
                <ListPlus className="size-3.5" /> Add several items
              </Button>
              {offers && (
                <label className="ml-1 flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Offer</span>
                  <Input type="number" min="0" max="100" step="any" value={offerPct} onChange={(e) => applyOffer(e.target.value)}
                    placeholder="0" className="h-8 w-20 text-right tabular" aria-label="Offer discount percent" data-slot="offer-pct" />
                  <span className="text-muted-foreground">% off every line</span>
                </label>
              )}
            </div>
            <div className="min-w-[240px] space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-sm" data-slot="quick-totals">
              {totals.discount > 0 && (
                <>
                  <div className="flex justify-between gap-4 text-muted-foreground"><span>Before discount</span><Money value={totals.gross} /></div>
                  <div className="flex justify-between gap-4 text-emerald-700 dark:text-emerald-400"><span>Discount</span><span className="tabular">−{formatINR(totals.discount)}</span></div>
                </>
              )}
              <div className="flex justify-between gap-4 text-muted-foreground"><span>{taxed ? 'Taxable' : 'Goods value'}</span><Money value={totals.taxable} /></div>
              {taxed && <div className="flex justify-between gap-4 text-muted-foreground"><span>GST</span><Money value={totals.tax} /></div>}
              <div className="flex justify-between gap-4 border-t pt-1 font-semibold"><span>Total</span><Money value={taxed ? totals.total : totals.taxable} /></div>
            </div>
          </div>

          {create.error && <p className="text-sm text-destructive">{create.error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={save} disabled={create.busy}>
            {create.busy ? 'Saving…' : buttonLabel}
          </Button>
        </DialogFooter>

        <ItemChecklist
          open={picking}
          onClose={() => setPicking(false)}
          options={itemChoices}
          already={new Set(lines.map((l) => l.itemId).filter(Boolean))}
          onAdd={(ids) => { addItems(ids); setPicking(false); }}
        />

        <QuickItemDialog
          open={newItem !== null}
          onOpenChange={(o) => !o && setNewItem(null)}
          initialName={newItem?.name ?? ''}
          onCreated={(item) => {
            if (!newItem) return;
            setLine(newItem.key, { itemId: item.id, rate: item.salePricePaise, gstRatePct: item.gstRatePct, discountPct: offer });
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/** Tick several items and add them all as lines. */
function ItemChecklist({ open, onClose, options, already, onAdd }: {
  open: boolean;
  onClose: () => void;
  options: { value: string; label: string; sublabel?: string; meta?: string; group?: string }[];
  already: Set<string>;
  onAdd: (ids: string[]) => void;
}) {
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const shown = options.filter((o) => !already.has(o.value) && `${o.label} ${o.sublabel ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { onClose(); setChosen([]); setQ(''); } }}>
      <DialogContent className="sm:max-w-2xl" data-slot="item-checklist">
        <DialogHeader>
          <DialogTitle>Add several items</DialogTitle>
          <DialogDescription>Tick every item the customer wants; each becomes a line with its own price and GST.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search items by name, SKU or HSN" className="pl-8" autoFocus />
        </div>
        <div className="max-h-[50vh] divide-y overflow-y-auto rounded-md border thin-scroll">
          {shown.length === 0 && <p className="p-4 text-center text-sm text-muted-foreground">No more items to add.</p>}
          {shown.map((o) => (
            <label key={o.value} className={cn('flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-accent/50', chosen.includes(o.value) && 'bg-primary/5')}>
              <input type="checkbox" checked={chosen.includes(o.value)} onChange={() => toggle(o.value)} aria-label={o.label} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{o.label}</span>
                {o.sublabel && <span className="block truncate text-xs text-muted-foreground">{o.sublabel}</span>}
              </span>
              {o.group && <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{o.group}</span>}
              {o.meta && <span className="tabular text-xs">{o.meta}</span>}
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { onClose(); setChosen([]); }}>Cancel</Button>
          <Button onClick={() => { onAdd(chosen); setChosen([]); setQ(''); }} disabled={!chosen.length} data-slot="add-chosen">
            Add {chosen.length || ''} item{chosen.length === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
