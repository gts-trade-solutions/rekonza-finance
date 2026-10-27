'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Item table, matching the Zoho Books layout:
//   ITEM DETAILS | HSN/SAC | QTY | RATE | DISCOUNT | TAX | AMOUNT
// Item selection uses the searchable Combobox, description sits under the item
// name, and discount can be entered as a percentage or a flat rupee amount.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { Layers, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useAppStore } from '@/lib/store';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { hsnOptions, itemOptionsFor } from '@/lib/options';
import { computeLineTax, GST_RATES, hsnRateOn } from '@/lib/tax/gst';
import { formatINR, toRupees } from '@/lib/money';
import { cn } from '@/lib/utils';
import { QuickItemDialog } from './quick-create';
import type { Item, SupplyType } from '@/lib/types';

export interface EditorLine {
  key: string;
  itemId: string | null;
  description: string;
  hsnSac: string;
  qty: number;
  uqc: string;
  ratePaise: number;
  discountPct: number;
  /** Flat rupee discount, used when discountMode is 'amount'. */
  discountPaise: number;
  discountMode: 'percent' | 'amount';
  gstRatePct: number;
  /** From the line's HSN code; goods such as tobacco carry it on top of GST. */
  cessRatePct: number;
  /** A batch-tracked item bought: the batch on the pack and its expiry. */
  batchNo?: string;
  expiryDate?: string;
  /** A batch-tracked item sold: the batch picked; empty takes the first to expire. */
  batchId?: string;
  /** A serial-tracked item: the pieces' numbers as typed or scanned, one per line or comma-separated. */
  serialText?: string;
  /** The quantity is being typed in the item's second unit; it is still held in the main one. */
  inAlt?: boolean;
}

/** The serial numbers on a line, as the API takes them; undefined when none are named. */
export function serialsOf(l: EditorLine): string[] | undefined {
  const list = (l.serialText ?? '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

export function newEditorLine(key: string): EditorLine {
  return {
    key,
    itemId: null,
    description: '',
    hsnSac: '',
    qty: 1,
    uqc: 'NOS',
    ratePaise: 0,
    discountPct: 0,
    discountPaise: 0,
    discountMode: 'percent',
    gstRatePct: 18,
    cessRatePct: 0,
  };
}

/** Effective discount percentage, whichever way the user entered it. */
export function effectiveDiscountPct(l: EditorLine): number {
  const gross = Math.round(l.ratePaise * l.qty);
  if (l.discountMode === 'amount') {
    return gross > 0 ? (l.discountPaise / gross) * 100 : 0;
  }
  return l.discountPct;
}

export function LineItemsEditor({
  lines,
  onChange,
  supplyType,
  supplyKind = 'both',
  priceMode = 'sale',
  showItcColumn = false,
  itcValues,
  onItcChange,
  docDate,
  priceFor,
  discountFor,
  batchMode,
}: {
  lines: EditorLine[];
  /**
   * Batch- and serial-tracked items: typed in on a purchase ('enter'), picked
   * from stock on a sale ('pick').
   */
  batchMode?: 'enter' | 'pick';
  /** The party's own price for an item (a price list), used instead of the item's price when given. */
  priceFor?: (itemId: string) => number | undefined;
  /** The discount the party's price list gives a quantity of an item, if any. */
  discountFor?: (itemId: string, qty: number) => number | undefined;
  onChange: (lines: EditorLine[]) => void;
  supplyType: SupplyType;
  /** The document's date. A code with dated rates is charged the one in force on it. */
  docDate?: string;
  /** Restricts both the item list and the HSN/SAC codes offered on each line. */
  supplyKind?: 'goods' | 'service' | 'both';
  priceMode?: 'sale' | 'purchase';
  showItcColumn?: boolean;
  itcValues?: Record<string, 'eligible' | 'ineligible' | 'capital_goods'>;
  onItcChange?: (key: string, v: 'eligible' | 'ineligible' | 'capital_goods') => void;
}) {
  const s = useAppStore();
  const batches = useApi<{ batches: { batchId: string; itemId: string; batchNo: string; expiryDate: string | null; qty: number }[] }>(
    () => (batchMode === 'pick' ? api.get('/api/batches') : Promise.resolve({ batches: [] })),
    [batchMode],
  );
  // Numbered pieces on hand, offered on a sale.
  const inStock = useApi<{ serials: { itemId: string; serialNo: string }[] }>(
    () => (batchMode === 'pick' ? api.get('/api/serials', { inStock: 1 }) : Promise.resolve({ serials: [] })),
    [batchMode],
  );
  const options = useMemo(() => itemOptionsFor(s, supplyKind, priceMode), [s, supplyKind, priceMode]);
  // Only the organisation's approved codes, narrowed to goods or services.
  const codes = useMemo(() => hsnOptions(s, supplyKind), [s, supplyKind]);
  const isZeroRated =
    supplyType === 'export_lut' || supplyType === 'sez' || supplyType === 'nil_or_exempt';

  const itemOf = (id: string | null) => (id ? s.items.find((i) => i.id === id) : undefined);

  const update = (key: string, patch: Partial<EditorLine>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  // Which line is waiting on a newly created item, and what was typed into its
  // picker. Held together so the item lands on the line that asked for it —
  // the dialog is one component for the whole table, not one per row.
  const [creating, setCreating] = useState<{ key: string; name: string } | null>(null);

  /**
   * What a code charges on the document's date. A code with dated rates decides
   * the GST; one without leaves the item's own rate standing. Cess always comes
   * from the code, because it is decided by what the goods are.
   */
  const codeRates = (code: string | null | undefined) => {
    const c = code ? s.hsnCodes.find((h) => h.code === code) : undefined;
    if (!c) return { dated: false, gstRatePct: null as number | null, cessRatePct: 0 };
    const r = hsnRateOn(c, docDate);
    return { dated: !!c.rates?.length, gstRatePct: r.gstRatePct, cessRatePct: r.cessRatePct };
  };

  /** Copy an item's own figures onto a line. Shared by picking and creating. */
  const applyItem = (key: string, item: Item) => {
    const r = codeRates(item.hsnSac);
    update(key, {
      itemId: item.id,
      description: item.description ?? '',
      hsnSac: item.hsnSac,
      uqc: item.uqc,
      ratePaise: priceFor?.(item.id) ?? (priceMode === 'sale' ? item.salePricePaise : item.purchasePricePaise),
      ...(discountFor?.(item.id, lines.find((l) => l.key === key)?.qty ?? 1) ? { discountPct: discountFor(item.id, lines.find((l) => l.key === key)?.qty ?? 1)!, discountMode: 'percent' as const } : {}),
      gstRatePct: r.dated && r.gstRatePct !== null ? r.gstRatePct : item.gstRatePct,
      cessRatePct: r.cessRatePct,
    });
  };

  // A rate change is decided by the document's date, so moving the date across
  // one re-prices every line whose code has dated rates.
  useEffect(() => {
    if (!docDate) return;
    let changed = false;
    const next = lines.map((l) => {
      const r = codeRates(l.hsnSac);
      if (!r.dated || r.gstRatePct === null) return l;
      if (l.gstRatePct === r.gstRatePct && l.cessRatePct === r.cessRatePct) return l;
      changed = true;
      return { ...l, gstRatePct: r.gstRatePct, cessRatePct: r.cessRatePct };
    });
    if (changed) onChange(next);
    // Only the date should trigger this; lines changing for other reasons must
    // not re-impose the code's rate over one the user chose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docDate]);

  const pickItem = (key: string, itemId: string) => {
    const item = s.items.find((i) => i.id === itemId);
    if (item) applyItem(key, item);
  };

  const addLine = () =>
    onChange([...lines, newEditorLine(`l${lines.length}_${Math.random().toString(36).slice(2, 7)}`)]);

  const addBulk = () => {
    const fresh = Array.from({ length: 3 }, (_, i) =>
      newEditorLine(`b${lines.length + i}_${Math.random().toString(36).slice(2, 7)}`),
    );
    onChange([...lines, ...fresh]);
  };

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-md border thin-scroll">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="border-b bg-muted/60 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="w-[30%] px-3 py-2 text-left">Item Details</th>
              <th className="w-[10%] px-2 py-2 text-left">HSN/SAC</th>
              <th className="w-[9%] px-2 py-2 text-right">Quantity</th>
              <th className="w-[12%] px-2 py-2 text-right">Rate</th>
              <th className="w-[13%] px-2 py-2 text-right">Discount</th>
              <th className="w-[9%] px-2 py-2 text-right">Tax</th>
              {showItcColumn && <th className="w-[10%] px-2 py-2 text-left">ITC</th>}
              <th className="w-[13%] px-3 py-2 text-right">Amount</th>
              <th className="w-9 px-1 py-2" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const { tax, total } = computeLineTax({
                ratePaise: line.ratePaise,
                qty: line.qty,
                discountPct: effectiveDiscountPct(line),
                gstRatePct: isZeroRated ? 0 : line.gstRatePct,
                cessRatePct: isZeroRated ? 0 : line.cessRatePct,
                supplyType,
              });
              const item = itemOf(line.itemId);
              const alt = item?.altUqc && item.altFactor ? { uqc: item.altUqc, factor: item.altFactor } : null;
              const inAlt = !!alt && !!line.inAlt;
              const named = serialsOf(line) ?? [];
              const each = line.qty > 0 ? Math.round(total / line.qty) : 0;
              const overMrp = priceMode === 'sale' && !!item?.mrpPaise && each > item.mrpPaise;
              return (
                <tr key={line.key} className="border-b align-top last:border-0">
                  {/* Item + description */}
                  <td className="px-3 py-2">
                    <Combobox
                      options={options}
                      value={line.itemId ?? ''}
                      onChange={(v) => pickItem(line.key, v)}
                      placeholder="Type or click to select an item"
                      searchPlaceholder="Search items by name, SKU or HSN"
                      showAvatar={false}
                      className="h-8"
                      createLabel="New item"
                      onCreate={(q) => setCreating({ key: line.key, name: q })}
                    />
                    <textarea
                      value={line.description}
                      onChange={(e) => update(line.key, { description: e.target.value })}
                      rows={1}
                      placeholder="Add a description"
                      className="mt-1 w-full resize-y rounded border border-input bg-surface px-2 py-1 text-xs outline-none placeholder:text-muted-foreground/70 focus:border-ring focus:ring-2 focus:ring-ring/25"
                    />
                    {batchMode && line.itemId && s.items.find((i) => i.id === line.itemId)?.trackBatches && (
                      batchMode === 'enter' ? (
                        <div className="mt-1 flex gap-1">
                          <input value={line.batchNo ?? ''} onChange={(e) => update(line.key, { batchNo: e.target.value })} placeholder="Batch no."
                            className="h-7 w-1/2 rounded border border-input bg-surface px-2 text-xs outline-none focus:border-ring" />
                          <input type="date" value={line.expiryDate ?? ''} onChange={(e) => update(line.key, { expiryDate: e.target.value })} title="Expiry"
                            className="h-7 w-1/2 rounded border border-input bg-surface px-2 text-xs outline-none focus:border-ring" />
                        </div>
                      ) : (
                        <select value={line.batchId ?? ''} onChange={(e) => update(line.key, { batchId: e.target.value })}
                          className="mt-1 h-7 w-full rounded border border-input bg-surface px-1 text-xs outline-none focus:border-ring">
                          <option value="">Batch: first to expire</option>
                          {(batches.data?.batches ?? []).filter((b) => b.itemId === line.itemId).map((b) => (
                            <option key={b.batchId} value={b.batchId}>{b.batchNo}{b.expiryDate ? ` · exp ${b.expiryDate}` : ''} · {b.qty} left</option>
                          ))}
                        </select>
                      )
                    )}
                    {batchMode && item?.trackSerials && (
                      <div className="mt-1">
                        <textarea
                          value={line.serialText ?? ''}
                          onChange={(e) => update(line.key, { serialText: e.target.value })}
                          rows={Math.min(4, Math.max(1, named.length))}
                          placeholder="Serial numbers, one per line or separated by commas"
                          aria-label="Serial numbers"
                          className="w-full resize-y rounded border border-input bg-surface px-2 py-1 font-mono text-xs outline-none placeholder:font-sans placeholder:text-muted-foreground/70 focus:border-ring"
                        />
                        <p className={cn('text-[10px]', named.length && named.length !== line.qty ? 'text-destructive' : 'text-muted-foreground')}>
                          {named.length} of {line.qty} numbered
                        </p>
                        {batchMode === 'pick' && (() => {
                          const free = (inStock.data?.serials ?? []).filter((x) => x.itemId === line.itemId && !named.includes(x.serialNo));
                          return free.length > 0 && named.length < line.qty ? (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {free.slice(0, 12).map((x) => (
                                <button key={x.serialNo} type="button"
                                  onClick={() => update(line.key, { serialText: [...named, x.serialNo].join('\n') })}
                                  className="rounded border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground">
                                  + {x.serialNo}
                                </button>
                              ))}
                              {free.length > 12 && <span className="text-[10px] text-muted-foreground">and {free.length - 12} more in stock</span>}
                            </div>
                          ) : null;
                        })()}
                      </div>
                    )}
                  </td>

                  <td className="px-2 py-2">
                    <Combobox
                      options={codes}
                      value={line.hsnSac}
                      onChange={(v) => {
                        // Picking a code with no item behind it also sets the
                        // rate, because the code is what determines the rate —
                        // the one in force on the document's date. Cess follows
                        // the code whether or not there is an item.
                        const r = codeRates(v);
                        update(line.key, {
                          hsnSac: v,
                          cessRatePct: r.cessRatePct,
                          ...(r.gstRatePct !== null && (!line.itemId || r.dated) ? { gstRatePct: r.gstRatePct } : {}),
                        });
                      }}
                      placeholder="Code"
                      searchPlaceholder="Type the first digits"
                      emptyMessage="Not on the approved list. Ask an admin to add it."
                      matchMode="prefix"
                      showAvatar={false}
                      clearable
                      className="h-8 text-xs"
                      contentClassName="w-80"
                    />
                  </td>

                  <td className="px-2 py-2">
                    <Input
                      type="number"
                      min="0"
                      step="any"
                      value={inAlt ? +(line.qty / alt!.factor).toFixed(4) : line.qty}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value || '0');
                        // Typed in the second unit, held in the main one: stock and tax stay in one unit.
                        const qty = inAlt ? +(v * alt!.factor).toFixed(6) : v;
                        // A quantity break on the price list moves the discount with it.
                        const d = line.itemId && line.discountMode === 'percent' ? discountFor?.(line.itemId, qty) : undefined;
                        update(line.key, { qty, ...(d !== undefined ? { discountPct: d } : {}) });
                      }}
                      className="h-8 text-right tabular"
                    />
                    {alt ? (
                      <div className="mt-1 text-right text-[10px] text-muted-foreground">
                        <button type="button" onClick={() => update(line.key, { inAlt: !line.inAlt })}
                          title={`Type the quantity in ${inAlt ? line.uqc : alt.uqc} instead`}
                          className="rounded px-1 font-medium text-primary hover:bg-accent">
                          {inAlt ? alt.uqc : line.uqc} ⇄
                        </button>
                        <span className="block tabular">
                          = {inAlt ? `${+line.qty.toFixed(3)} ${line.uqc}` : `${+(line.qty / alt.factor).toFixed(3)} ${alt.uqc}`}
                        </span>
                      </div>
                    ) : (
                      <p className="mt-1 text-right text-[10px] text-muted-foreground">{line.uqc}</p>
                    )}
                  </td>

                  <td className="px-2 py-2">
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={line.ratePaise === 0 ? '' : toRupees(line.ratePaise)}
                      onChange={(e) =>
                        update(line.key, {
                          ratePaise: Math.round(parseFloat(e.target.value || '0') * 100),
                        })
                      }
                      placeholder="0.00"
                      className="h-8 text-right tabular"
                    />
                    {alt && line.ratePaise > 0 && (
                      <p className="mt-1 text-right text-[10px] text-muted-foreground tabular">
                        {formatINR(Math.round(line.ratePaise * alt.factor))} / {alt.uqc}
                      </p>
                    )}
                    {priceMode === 'sale' && item?.mrpPaise ? (
                      <p className={cn('mt-1 text-right text-[10px] tabular', overMrp ? 'font-medium text-destructive' : 'text-muted-foreground')}
                        title={overMrp ? 'With tax, a unit goes for more than its MRP' : undefined}>
                        MRP {formatINR(item.mrpPaise)}
                      </p>
                    ) : null}
                  </td>

                  {/* Discount with %/₹ toggle, exactly as Zoho does it */}
                  <td className="px-2 py-2">
                    <div className="flex">
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={
                          line.discountMode === 'percent'
                            ? line.discountPct || ''
                            : line.discountPaise === 0
                              ? ''
                              : toRupees(line.discountPaise)
                        }
                        onChange={(e) => {
                          const n = parseFloat(e.target.value || '0');
                          update(
                            line.key,
                            line.discountMode === 'percent'
                              ? { discountPct: n }
                              : { discountPaise: Math.round(n * 100) },
                          );
                        }}
                        placeholder="0"
                        className="h-8 rounded-r-none text-right tabular"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          update(line.key, {
                            discountMode: line.discountMode === 'percent' ? 'amount' : 'percent',
                          })
                        }
                        title="Switch between percentage and amount"
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-r border border-l-0 border-input bg-muted text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      >
                        {line.discountMode === 'percent' ? '%' : '₹'}
                      </button>
                    </div>
                  </td>

                  <td className="px-2 py-2">
                    <Select
                      value={String(line.gstRatePct)}
                      onValueChange={(v) => update(line.key, { gstRatePct: Number(v) })}
                      disabled={isZeroRated}
                    >
                      <SelectTrigger className="h-8 w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {GST_RATES.map((r) => (
                          <SelectItem key={r} value={String(r)}>{r}%</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {!isZeroRated && line.cessRatePct > 0 && (
                      <p className="mt-1 text-right text-[10px] text-muted-foreground">+ {line.cessRatePct}% cess</p>
                    )}
                  </td>

                  {showItcColumn && (
                    <td className="px-2 py-2">
                      <Select
                        value={itcValues?.[line.key] ?? 'eligible'}
                        onValueChange={(v) => onItcChange?.(line.key, v as never)}
                      >
                        <SelectTrigger className="h-8 w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="eligible">Eligible</SelectItem>
                          <SelectItem value="ineligible">Ineligible</SelectItem>
                          <SelectItem value="capital_goods">Capital goods</SelectItem>
                        </SelectContent>
                      </Select>
                    </td>
                  )}

                  <td className="px-3 py-2 text-right">
                    <p className="pt-1.5 text-sm font-medium tabular">{formatINR(total)}</p>
                    {!isZeroRated && tax.taxablePaise > 0 && (
                      <p className="mt-0.5 text-[10px] text-muted-foreground tabular">
                        Taxable {formatINR(tax.taxablePaise)}
                      </p>
                    )}
                  </td>

                  <td className="px-1 py-2">
                    <button
                      type="button"
                      onClick={() => onChange(lines.filter((l) => l.key !== line.key))}
                      disabled={lines.length === 1}
                      aria-label="Remove line"
                      className={cn(
                        'mt-1 grid size-7 place-items-center rounded text-muted-foreground transition-colors',
                        lines.length === 1
                          ? 'cursor-not-allowed opacity-30'
                          : 'hover:bg-destructive/10 hover:text-destructive',
                      )}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={addLine} className="gap-1.5">
          <Plus className="size-3.5" /> Add New Row
        </Button>
        <Button variant="ghost" size="sm" onClick={addBulk} className="gap-1.5 text-primary">
          <Layers className="size-3.5" /> Add Items in Bulk
        </Button>
      </div>

      {/* One dialog for the whole table. It saves the item to the catalogue and
          then fills the line that asked for it — so the rate, the HSN and the
          GST rate arrive on the document exactly as they would have if the item
          had already existed. */}
      <QuickItemDialog
        open={creating !== null}
        onOpenChange={(o) => !o && setCreating(null)}
        initialName={creating?.name ?? ''}
        priceMode={priceMode}
        defaultKind={supplyKind === 'service' ? 'service' : 'goods'}
        onCreated={(item) => {
          if (creating) applyItem(creating.key, item);
        }}
      />
    </div>
  );
}
