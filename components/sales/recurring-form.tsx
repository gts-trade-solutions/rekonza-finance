'use client';

// Zoho Books' New / Edit Recurring Invoice, recorded from Zoho's demo on
// 2026-11-23: Customer Name, Profile Name, Order Number, Repeat Every (Week,
// 2 Weeks, Month, 2/3/6 Months, Year, 2/3 Years, Custom), Start On, Ends On /
// Never Expires, Payment Terms, Salesperson, the item table, Customer Notes,
// Terms & Conditions, "Preferences: Create Invoices as Drafts", and Save ·
// Cancel; an empty save says "Select a customer.". Recorded again on
// 2026-11-24 (migration 126): the Entity type (Invoice / Bill Of Supply), and
// in the totals Shipping Charges, the adjustment row and Round Off "(No
// Rounding)" with its pencil and "Rounding Off Preference" window. Rekonza's own two
// preferences sit beside Zoho's: send each invoice by itself, and raise it on
// its dates without anyone pressing Run.
//
// It starts from an invoice (?invoice=, the invoice's ⋯ → Make Recurring),
// from the unsaved New Invoice form (?from=form, its Make Recurring), or from
// a copy (?clone=).

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleHelp, Loader2, Pencil, Repeat } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { roundToRupee, toRupees } from '@/lib/money';
import { ContactPicker } from '@/components/forms/quick-create';
import { DocumentForm, FormErrors, FormRow, FormRowPair } from '@/components/shared/form-layout';
import { LineItemsEditor, effectiveDiscountPct, newEditorLine, type EditorLine } from '@/components/forms/document-lines';
import { Money } from '@/components/shared/money';
import { useAppStore } from '@/lib/store';
import { localDay } from '@/lib/selectors';
import { termsOptions, userOptions } from '@/lib/options';
import { api, ApiError, invoices as invoiceApi, recurringInvoices, type RecurringProfileDetail } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { MultiCombobox } from '@/components/ui/multi-combobox';
import { listRate, type PriceListShape } from '@/lib/price-list-rate';
import { RECURRING_FROM_FORM } from '@/lib/recurring-handoff';
import { REPEAT_CHOICES, repeatChoice, type RepeatUnit } from '@/lib/recurring-repeat';
import { computeLineTax, placeOfSupplyFor, resolveSupplyType } from '@/lib/tax/gst';
import { refreshSplitList } from '@/components/shared/record-split';

type SourceLine = { itemId: string | number | null; description: string | null; qty: number; ratePaise: number; gstRatePct: number; hsnSac: string | null; discountPct?: number };
type EntityType = 'invoice' | 'bill_of_supply';
type RoundOff = 'none' | 'whole';
/** Zoho's two choices in its "Rounding Off Preference" window, in its words. */
const ROUNDING: { value: RoundOff; label: string; short: string }[] = [
  { value: 'none', label: 'No Rounding', short: '(No Rounding)' },
  { value: 'whole', label: 'Round off the total to the nearest whole number', short: '(Nearest Whole Number)' },
];
/** A rupee amount typed in a totals box, as paise; empty is nothing. */
const paiseOf = (v: string) => (v.trim() === '' || v.trim() === '-' ? 0 : Math.round(parseFloat(v) * 100) || 0);

/** Zoho's (?) beside a totals box. */
function Tip({ label, children }: { label: string; children: string }) {
  return (
    <Tooltip>
      <TooltipTrigger aria-label={`About ${label}`} className="inline-grid size-4 place-items-center rounded-full text-muted-foreground hover:text-foreground"
        data-slot="totals-help" render={<span role="button" tabIndex={0} />}>
        <CircleHelp className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-[12px] leading-relaxed">{children}</TooltipContent>
    </Tooltip>
  );
}
let n = 0;
const toEditor = (l: SourceLine): EditorLine => ({
  ...newEditorLine(`l${n++}`), itemId: l.itemId == null ? null : String(l.itemId), description: l.description ?? '', hsnSac: l.hsnSac ?? '',
  qty: l.qty, ratePaise: l.ratePaise, gstRatePct: l.gstRatePct, discountPct: l.discountPct ?? 0,
});
const CUSTOM_UNITS: { value: RepeatUnit; label: string }[] = [
  { value: 'daily', label: 'Day(s)' }, { value: 'weekly', label: 'Week(s)' }, { value: 'monthly', label: 'Month(s)' }, { value: 'yearly', label: 'Year(s)' },
];

export function RecurringForm({ editing }: { editing?: RecurringProfileDetail }) {
  const router = useRouter();
  const params = useSearchParams();
  const s = useAppStore();
  const [customerId, setCustomerId] = useState(editing?.customerId ?? '');
  const [entityType, setEntityType] = useState<EntityType>(editing?.entityType ?? 'invoice');
  // The totals' boxes, as typed (rupees); kept as text so a minus sign or a half-typed amount stays put.
  const [shippingText, setShippingText] = useState(editing?.shippingChargePaise ? String(toRupees(editing.shippingChargePaise)) : '');
  const [adjustmentText, setAdjustmentText] = useState(editing?.adjustmentPaise ? String(toRupees(editing.adjustmentPaise)) : '');
  const [adjustmentLabel, setAdjustmentLabel] = useState(editing?.adjustmentLabel ?? 'Adjustment');
  const [roundOff, setRoundOff] = useState<RoundOff>(editing?.roundOff ?? 'none');
  const [roundingOpen, setRoundingOpen] = useState(false);
  const [roundingChoice, setRoundingChoice] = useState<RoundOff>(editing?.roundOff ?? 'none');
  const [name, setName] = useState(editing?.name ?? '');
  const [orderNumber, setOrderNumber] = useState(editing?.orderNumber ?? '');
  const [choice, setChoice] = useState(editing ? repeatChoice(editing.frequency, editing.every) : 'week');
  const [customEvery, setCustomEvery] = useState(editing && repeatChoice(editing.frequency, editing.every) === 'custom' ? editing.every : 1);
  const [customUnit, setCustomUnit] = useState<RepeatUnit>(editing && repeatChoice(editing.frequency, editing.every) === 'custom' ? editing.frequency : 'daily');
  const [startDate, setStartDate] = useState(editing?.startDate ?? localDay(new Date()));
  const [neverExpires, setNeverExpires] = useState(editing ? !editing.endDate : true);
  const [endDate, setEndDate] = useState(editing?.endDate ?? '');
  const [paymentTerms, setPaymentTerms] = useState(editing?.paymentTerms ?? 'due_on_receipt');
  const [salespersonId, setSalespersonId] = useState(editing?.salespersonId ?? '');
  const [lines, setLines] = useState<EditorLine[]>(editing ? editing.lines.map(toEditor) : [newEditorLine('l-first')]);
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [terms, setTerms] = useState(editing?.terms ?? '');
  const [asDraft, setAsDraft] = useState(editing?.createAsDraft ?? false);
  const [autoSend, setAutoSend] = useState(editing?.autoSend ?? false);
  const [autoRun, setAutoRun] = useState(editing?.autoRun ?? false);
  // Zoho's Select Price List, Associate Project(s) Hours and Associate Payment Options.
  const [priceListId, setPriceListId] = useState(editing?.priceListId ?? '');
  const [projectIds, setProjectIds] = useState<string[]>(editing?.projects.map((x) => x.id) ?? []);
  const [paymentLink, setPaymentLink] = useState(editing?.paymentLink ?? false);
  const priceLists = useApi<{ lists: PriceListShape[] }>(() => api.get('/api/price-lists'), []);
  const projects = useApi<{ projects: { id: string; name: string }[] }>(
    () => (customerId ? api.get('/api/projects', { customerId, status: 'active' }) : Promise.resolve({ projects: [] })), [customerId],
  );
  const gateway = useApi<{ connected: boolean }>(() => api.get('/api/payment-links'), []);
  const list = (priceLists.data?.lists ?? []).find((l) => l.id === priceListId) ?? null;
  // The list's rate (and its discount) on a line whose item was just chosen, or on every line when the list changes.
  const priced = (l: EditorLine): EditorLine => {
    if (!list || !l.itemId) return l;
    const item = s.items.find((i) => i.id === l.itemId);
    if (!item) return l;
    const r = listRate(list, l.itemId, item.salePricePaise, l.qty);
    return { ...l, ratePaise: r.ratePaise, discountPct: r.discountPct, discountMode: 'percent' };
  };
  const setLinesPriced = (next: EditorLine[]) => setLines(next.map((l) => {
    const before = lines.find((x) => x.key === l.key);
    return before && before.itemId === l.itemId ? l : priced(l);
  }));
  useEffect(() => { if (list) setLines((ls) => ls.map(priced)); }, [priceListId, priceLists.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!editing || customerId !== editing.customerId) setProjectIds([]); }, [customerId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // Where it starts from: an invoice, the unsaved invoice form, or a copy.
  const started = useRef(false);
  useEffect(() => {
    if (editing || started.current) return;
    started.current = true;
    const fromInvoice = params.get('invoice');
    const cloneId = params.get('clone');
    if (params.get('from') === 'form') {
      try {
        const saved = JSON.parse(sessionStorage.getItem(RECURRING_FROM_FORM) ?? 'null') as {
          customerId: string; paymentTerms: string; lines: SourceLine[];
          shippingChargePaise?: number; adjustmentPaise?: number; adjustmentLabel?: string;
        } | null;
        sessionStorage.removeItem(RECURRING_FROM_FORM);
        if (saved) {
          setCustomerId(saved.customerId);
          if (saved.paymentTerms) setPaymentTerms(saved.paymentTerms);
          if (saved.lines.length) setLines(saved.lines.map(toEditor));
          if (saved.shippingChargePaise) setShippingText(String(toRupees(saved.shippingChargePaise)));
          if (saved.adjustmentPaise) setAdjustmentText(String(toRupees(saved.adjustmentPaise)));
          if (saved.adjustmentLabel) setAdjustmentLabel(saved.adjustmentLabel);
        }
      } catch { /* nothing carried over */ }
    } else if (fromInvoice) {
      invoiceApi.get(fromInvoice).then((inv) => {
        setCustomerId(inv.customer.id);
        setName(`${inv.customer.name} – ${inv.number}`);
        if (inv.paymentTerms) setPaymentTerms(inv.paymentTerms);
        if (inv.orderNumber) setOrderNumber(inv.orderNumber);
        setLines(inv.lines.map((l) => toEditor({ itemId: l.itemId, description: l.description ?? l.itemName ?? null, qty: l.qty, ratePaise: l.ratePaise, gstRatePct: l.gstRatePct, hsnSac: l.hsnSac, discountPct: l.discountPct })));
        setNotes(inv.notes ?? ''); setTerms(inv.terms ?? '');
        if (inv.billOfSupply) setEntityType('bill_of_supply');
        if (inv.shippingChargePaise) setShippingText(String(toRupees(inv.shippingChargePaise)));
        if (inv.adjustmentPaise) setAdjustmentText(String(toRupees(inv.adjustmentPaise)));
        if (inv.adjustmentLabel) setAdjustmentLabel(inv.adjustmentLabel);
      }).catch(() => toast.error('That invoice could not be read'));
    } else if (cloneId) {
      recurringInvoices.get(cloneId).then((p) => {
        setCustomerId(p.customerId); setName(`${p.name} (copy)`); setOrderNumber(p.orderNumber ?? '');
        setChoice(repeatChoice(p.frequency, p.every)); setCustomEvery(p.every); setCustomUnit(p.frequency);
        setPaymentTerms(p.paymentTerms ?? 'due_on_receipt'); setSalespersonId(p.salespersonId ?? '');
        setLines(p.lines.map(toEditor)); setNotes(p.notes ?? ''); setTerms(p.terms ?? ''); setAsDraft(p.createAsDraft); setAutoSend(p.autoSend);
        setEntityType(p.entityType); setRoundOff(p.roundOff); setRoundingChoice(p.roundOff); setAdjustmentLabel(p.adjustmentLabel);
        setShippingText(p.shippingChargePaise ? String(toRupees(p.shippingChargePaise)) : ''); setAdjustmentText(p.adjustmentPaise ? String(toRupees(p.adjustmentPaise)) : '');
      }).catch(() => toast.error('That profile could not be copied'));
    }
  }, [editing, params]);

  const customer = s.contacts.find((c) => c.id === customerId);
  const branch = s.branches.find((b) => b.id === (editing?.branchId ?? s.activeBranchId)) ?? s.branches[0];
  const supplyType = useMemo(() => (customer && branch
    ? resolveSupplyType({ branchStateCode: branch.stateCode, placeOfSupply: placeOfSupplyFor({ billToState: customer.stateCode ?? branch.stateCode, servicesOnly: false }), customerTreatment: customer.gstTreatment })
    : 'intra'), [customer, branch]);
  const shippingPaise = paiseOf(shippingText);
  const adjustmentPaise = paiseOf(adjustmentText);
  const totals = useMemo(() => {
    const parts = lines.map((l) => computeLineTax({ ratePaise: l.ratePaise, qty: l.qty, discountPct: effectiveDiscountPct(l), gstRatePct: l.gstRatePct, cessRatePct: l.cessRatePct, supplyType }));
    const sub = parts.reduce((t, p) => t + p.taxable, 0);
    // A bill of supply carries no tax.
    const tax = entityType === 'bill_of_supply' ? 0 : parts.reduce((t, p) => t + p.total - p.taxable, 0);
    const gross = sub + tax + shippingPaise + adjustmentPaise;
    const r = roundOff === 'whole' ? roundToRupee(gross) : { rounded: gross, roundOff: 0 };
    return { sub, tax, roundOff: r.roundOff, total: r.rounded };
  }, [lines, supplyType, entityType, shippingPaise, adjustmentPaise, roundOff]);
  const back = editing ? `/sales/recurring/${editing.id}` : '/sales/recurring';
  const repeat = choice === 'custom'
    ? { frequency: customUnit, every: Math.max(1, Math.floor(customEvery) || 1) }
    : REPEAT_CHOICES.find((c) => c.value === choice) ?? REPEAT_CHOICES[0];

  const save = async () => {
    const problems: string[] = [];
    if (!customerId) problems.push('Select a customer.');
    if (!name.trim()) problems.push('Enter the profile name.');
    const filled = lines.filter((l) => l.itemId || l.description.trim());
    if (!filled.length) problems.push('Enter the valid item name or description.');
    if (!neverExpires && endDate && endDate < startDate) problems.push('The end date cannot be before the start date.');
    if (shippingPaise < 0) problems.push('Shipping charges cannot be below zero.');
    setErrors(problems);
    if (problems.length) return;
    setSaving(true);
    const payload = {
      customerId, name: name.trim(), orderNumber: orderNumber || null, frequency: repeat.frequency, every: repeat.every,
      entityType, shippingChargePaise: shippingPaise, adjustmentPaise, adjustmentLabel: adjustmentLabel.trim() || 'Adjustment', roundOff,
      startDate, endDate: neverExpires ? null : endDate || null, paymentTerms, salespersonId: salespersonId || null,
      notes: notes || null, terms: terms || null, createAsDraft: asDraft, autoSend, autoRun,
      priceListId: priceListId || null, projectIds, paymentLink,
      // The rate and the discount kept apart, as Zoho's item table has them.
      lines: filled.map((l) => ({
        itemId: l.itemId, description: l.description || null, qty: l.qty,
        ratePaise: l.ratePaise, discountPct: Math.round(effectiveDiscountPct(l) * 100) / 100, gstRatePct: l.gstRatePct, hsnSac: l.hsnSac || null,
      })),
    };
    try {
      const r = editing ? await recurringInvoices.update(editing.id, payload) : await recurringInvoices.create(payload);
      toast.success(editing ? 'Recurring invoice saved' : 'Recurring invoice created', {
        description: editing ? 'The change applies from the next invoice.' : 'Nothing is billed until it runs: this is a profile, not an invoice.',
      });
      refreshSplitList();
      router.push(`/sales/recurring/${r.id}`);
    } catch (e) {
      setErrors([e instanceof ApiError ? e.message : String(e)]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <DocumentForm
      title={editing ? `Edit ${editing.name}` : 'New Recurring Invoice'}
      icon={<Repeat className="size-5 text-muted-foreground" />}
      backHref={back}
      footer={
        <>
          <Button onClick={() => void save()} disabled={saving} data-slot="recurring-save">{saving && <Loader2 className="size-4 animate-spin" />} Save</Button>
          <Button variant="outline" onClick={() => router.push(back)} disabled={saving}>Cancel</Button>
        </>
      }
      footerSummary={<p className="text-sm"><span className="text-muted-foreground">Total: </span><span className="font-semibold tabular"><Money value={totals.total} /></span></p>}
    >
      <FormErrors errors={errors} onClose={() => setErrors([])} />
      <div className="space-y-4" data-slot="recurring-form">
        <FormRow label="Customer Name" required width="lg">
          <ContactPicker kind="customer" value={customerId} onChange={setCustomerId} />
        </FormRow>
        <FormRow label="Entity type" width="lg">
          <div className="flex h-9 items-center gap-5 text-[13px]" role="radiogroup" aria-label="Entity type" data-slot="recurring-entity-type">
            {([['invoice', 'Invoice'], ['bill_of_supply', 'Bill Of Supply']] as const).map(([v, label]) => (
              <label key={v} className="flex cursor-pointer items-center gap-1.5">
                <input type="radio" name="entity-type" value={v} checked={entityType === v} onChange={() => setEntityType(v)} className="accent-[var(--color-primary)]" data-slot={`entity-${v}`} />
                {label}
              </label>
            ))}
          </div>
          {entityType === 'bill_of_supply' && (
            <p className="mt-1 text-[11px] text-muted-foreground" data-slot="entity-bos-note">Each one is a bill of supply: no tax, for exempt, nil-rated or non-GST goods (Rule 49).</p>
          )}
        </FormRow>
        <FormRow label="Profile Name" required width="lg"><Input value={name} onChange={(e) => setName(e.target.value)} data-slot="recurring-name" /></FormRow>
        <FormRow label="Order Number" width="lg"><Input value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} /></FormRow>
        <FormRow label="Repeat Every" required width="lg">
          <div className="flex flex-wrap gap-2">
            <Combobox options={[...REPEAT_CHOICES.map((c) => ({ value: c.value, label: c.label })), { value: 'custom', label: 'Custom' }]} value={choice} onChange={setChoice} showAvatar={false} />
            {choice === 'custom' && (
              <>
                <Input type="number" min={1} max={999} value={customEvery} onChange={(e) => setCustomEvery(Number(e.target.value))} className="w-24" aria-label="Every" />
                <Combobox options={CUSTOM_UNITS} value={customUnit} onChange={(v) => setCustomUnit(v as RepeatUnit)} showAvatar={false} />
              </>
            )}
          </div>
        </FormRow>
        <FormRowPair>
          <FormRow label="Start On"><Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></FormRow>
          <FormRow label="Ends On">
            <div className="flex items-center gap-3">
              <Input type="date" value={neverExpires ? '' : endDate} disabled={neverExpires} onChange={(e) => setEndDate(e.target.value)} />
              <label className="flex shrink-0 items-center gap-1.5 text-[13px]"><Checkbox checked={neverExpires} onCheckedChange={(v) => setNeverExpires(v === true)} data-slot="never-expires" /> Never Expires</label>
            </div>
          </FormRow>
        </FormRowPair>
        <FormRow label="Payment Terms" width="lg"><Combobox options={termsOptions()} value={paymentTerms} onChange={setPaymentTerms} showAvatar={false} /></FormRow>
        <FormRow label="Salesperson" width="lg"><Combobox options={userOptions(s)} value={salespersonId} onChange={setSalespersonId} placeholder="Select or Add Salesperson" clearable /></FormRow>
        <FormRow label="Associate Project(s) Hours" width="lg" hint="Each project's billable hours not yet invoiced are added to every invoice this profile raises.">
          {customerId && (projects.data?.projects.length ?? 0) > 0
            ? <MultiCombobox options={(projects.data?.projects ?? []).map((x) => ({ value: x.id, label: x.name }))} value={projectIds} onChange={setProjectIds} placeholder="Select projects" searchPlaceholder="Search projects" data-slot="recurring-projects" />
            : <p className="py-2 text-[13px] text-muted-foreground" data-slot="recurring-no-projects">{customerId ? 'There are no active projects for this customer.' : 'Select a customer to see their projects.'}</p>}
        </FormRow>
        <FormRow label="Select Price List" width="lg" hint="The rates of the items you add come from this list.">
          <Combobox options={(priceLists.data?.lists ?? []).filter((l) => l.isActive || l.id === priceListId).map((l) => ({ value: l.id, label: l.name }))}
            value={priceListId} onChange={setPriceListId} placeholder="Select Price List" showAvatar={false} clearable data-slot="recurring-price-list" />
        </FormRow>
      </div>

      <div className="space-y-2" data-slot="recurring-items">
        <p className="text-[15px] font-medium">Item Table</p>
        <LineItemsEditor docDate={startDate} lines={lines} onChange={setLinesPriced} supplyType={supplyType} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div><label className="mb-1 block text-[13px] text-field-label">Customer Notes</label>
            <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Will be displayed on the invoice" /></div>
          <div><label className="mb-1 block text-[13px] text-field-label">Terms &amp; Conditions</label>
            <Textarea rows={3} value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="Enter the terms and conditions of your business to be displayed in your transaction" /></div>
        </div>
        <div className="space-y-3 self-start rounded-[var(--radius-card)] bg-muted/30 p-4 text-[13px]" data-slot="recurring-totals">
          <div className="flex justify-between font-medium"><span>Sub Total</span><Money value={totals.sub} /></div>
          {entityType !== 'bill_of_supply' && <div className="flex justify-between"><span>Tax</span><Money value={totals.tax} /></div>}
          <div className="flex items-center justify-between gap-3">
            <span>Shipping Charges</span>
            <span className="flex items-center gap-2">
              <Input type="number" step="0.01" min="0" value={shippingText} onChange={(e) => setShippingText(e.target.value)} placeholder="0.00"
                className="h-8 w-28 text-right tabular" aria-label="Shipping Charges" data-slot="recurring-shipping" />
              <Tip label="Shipping Charges">Amount spent on shipping the goods.</Tip>
            </span>
            <Money value={shippingPaise} className="w-24 text-right" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Input value={adjustmentLabel} onChange={(e) => setAdjustmentLabel(e.target.value)} className="h-8 w-28 text-xs" aria-label="Adjustment label" data-slot="recurring-adjustment-label" />
            <span className="flex items-center gap-2">
              <Input type="number" step="0.01" value={adjustmentText} onChange={(e) => setAdjustmentText(e.target.value)} placeholder="0.00"
                className="h-8 w-28 text-right tabular" aria-label="Adjustment" data-slot="recurring-adjustment" />
              <Tip label="Adjustment">Add any other +ve or -ve charges that need to be applied to adjust the total amount of the transaction Eg. +10 or -10.</Tip>
            </span>
            <Money value={adjustmentPaise} className="w-24 text-right" />
          </div>
          <div className="flex items-start justify-between gap-3" data-slot="recurring-round-off">
            <div>
              <p>Round Off</p>
              <p className="flex items-center gap-2 text-muted-foreground">
                <span data-slot="round-off-choice">{ROUNDING.find((r) => r.value === roundOff)?.short}</span>
                <button type="button" aria-label="Rounding Off Preference" className="text-link hover:opacity-80" data-slot="round-off-edit"
                  onClick={() => { setRoundingChoice(roundOff); setRoundingOpen(true); }}>
                  <Pencil className="size-3.5" />
                </button>
              </p>
            </div>
            <Money value={totals.roundOff} className="tabular" />
          </div>
          <div className="flex justify-between border-t pt-2 text-[15px] font-semibold"><span>Total</span><Money value={totals.total} /></div>
        </div>
      </div>

      <Dialog open={roundingOpen} onOpenChange={setRoundingOpen}>
        <DialogContent className="sm:max-w-md" data-slot="rounding-dialog">
          <DialogHeader><DialogTitle>Rounding Off Preference</DialogTitle></DialogHeader>
          <div className="space-y-2.5 text-[13px]" role="radiogroup" aria-label="Rounding Off Preference">
            {ROUNDING.map((r) => (
              <label key={r.value} className="flex cursor-pointer items-center gap-2">
                <input type="radio" name="rounding" value={r.value} checked={roundingChoice === r.value} onChange={() => setRoundingChoice(r.value)}
                  className="accent-[var(--color-primary)]" data-slot={`rounding-${r.value}`} />
                {r.label}
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button onClick={() => { setRoundOff(roundingChoice); setRoundingOpen(false); }} data-slot="rounding-update">Update</Button>
            <Button variant="outline" onClick={() => setRoundingOpen(false)}>Cancel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="space-y-2 rounded-[var(--radius-card)] border p-4 text-[13px]" data-slot="recurring-preferences">
        <label className="flex items-center gap-2"><Checkbox checked={asDraft} onCheckedChange={(v) => setAsDraft(v === true)} data-slot="create-as-draft" />
          <span><span className="text-muted-foreground">Preferences : </span>Create Invoices as Drafts</span></label>
        <label className="flex items-center gap-2"><Checkbox checked={autoSend} disabled={asDraft} onCheckedChange={(v) => setAutoSend(v === true)} />
          Send each invoice to the customer when it is created</label>
        <label className="flex items-center gap-2"><Checkbox checked={autoRun} onCheckedChange={(v) => setAutoRun(v === true)} />
          Create each invoice on its date by itself (otherwise press Create Invoice)</label>
        <label className="flex items-center gap-2" data-slot="recurring-payment-options">
          <Checkbox checked={paymentLink} disabled={!gateway.data?.connected} onCheckedChange={(v) => setPaymentLink(v === true)} data-slot="recurring-payment-link" />
          <span><span className="text-muted-foreground">Associate Payment Options : </span>add an online payment link (Razorpay) to each invoice
            {!gateway.data?.connected && <span className="text-muted-foreground"> — connect online payments in <a href="/settings?tab=integrations" className="text-link hover:underline">Settings → Integrations</a> first</span>}</span>
        </label>
      </div>
    </DocumentForm>
  );
}
