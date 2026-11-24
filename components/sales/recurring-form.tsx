'use client';

// Zoho Books' New / Edit Recurring Invoice, recorded from Zoho's demo on
// 2026-11-23: Customer Name, Profile Name, Order Number, Repeat Every (Week,
// 2 Weeks, Month, 2/3/6 Months, Year, 2/3 Years, Custom), Start On, Ends On /
// Never Expires, Payment Terms, Salesperson, the item table, Customer Notes,
// Terms & Conditions, "Preferences: Create Invoices as Drafts", and Save ·
// Cancel; an empty save says "Select a customer.". Rekonza's own two
// preferences sit beside Zoho's: send each invoice by itself, and raise it on
// its dates without anyone pressing Run.
//
// It starts from an invoice (?invoice=, the invoice's ⋯ → Make Recurring),
// from the unsaved New Invoice form (?from=form, its Make Recurring), or from
// a copy (?clone=).

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Repeat } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import { ContactPicker } from '@/components/forms/quick-create';
import { DocumentForm, FormErrors, FormRow, FormRowPair } from '@/components/shared/form-layout';
import { LineItemsEditor, effectiveDiscountPct, newEditorLine, type EditorLine } from '@/components/forms/document-lines';
import { Money } from '@/components/shared/money';
import { useAppStore } from '@/lib/store';
import { localDay } from '@/lib/selectors';
import { termsOptions, userOptions } from '@/lib/options';
import { ApiError, invoices as invoiceApi, recurringInvoices, type RecurringProfileDetail } from '@/lib/api/client';
import { RECURRING_FROM_FORM } from '@/lib/recurring-handoff';
import { REPEAT_CHOICES, repeatChoice, type RepeatUnit } from '@/lib/recurring-repeat';
import { computeLineTax, placeOfSupplyFor, resolveSupplyType } from '@/lib/tax/gst';
import { refreshSplitList } from '@/components/shared/record-split';

type SourceLine = { itemId: string | number | null; description: string | null; qty: number; ratePaise: number; gstRatePct: number; hsnSac: string | null };
let n = 0;
const toEditor = (l: SourceLine): EditorLine => ({
  ...newEditorLine(`l${n++}`), itemId: l.itemId == null ? null : String(l.itemId), description: l.description ?? '', hsnSac: l.hsnSac ?? '',
  qty: l.qty, ratePaise: l.ratePaise, gstRatePct: l.gstRatePct,
});
const CUSTOM_UNITS: { value: RepeatUnit; label: string }[] = [
  { value: 'daily', label: 'Day(s)' }, { value: 'weekly', label: 'Week(s)' }, { value: 'monthly', label: 'Month(s)' }, { value: 'yearly', label: 'Year(s)' },
];

export function RecurringForm({ editing }: { editing?: RecurringProfileDetail }) {
  const router = useRouter();
  const params = useSearchParams();
  const s = useAppStore();
  const [customerId, setCustomerId] = useState(editing?.customerId ?? '');
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
        const saved = JSON.parse(sessionStorage.getItem(RECURRING_FROM_FORM) ?? 'null') as { customerId: string; paymentTerms: string; lines: SourceLine[] } | null;
        sessionStorage.removeItem(RECURRING_FROM_FORM);
        if (saved) {
          setCustomerId(saved.customerId);
          if (saved.paymentTerms) setPaymentTerms(saved.paymentTerms);
          if (saved.lines.length) setLines(saved.lines.map(toEditor));
        }
      } catch { /* nothing carried over */ }
    } else if (fromInvoice) {
      invoiceApi.get(fromInvoice).then((inv) => {
        setCustomerId(inv.customer.id);
        setName(`${inv.customer.name} – ${inv.number}`);
        if (inv.paymentTerms) setPaymentTerms(inv.paymentTerms);
        if (inv.orderNumber) setOrderNumber(inv.orderNumber);
        setLines(inv.lines.map((l) => toEditor({ itemId: l.itemId, description: l.description ?? l.itemName ?? null, qty: l.qty, ratePaise: l.ratePaise, gstRatePct: l.gstRatePct, hsnSac: l.hsnSac })));
        setNotes(inv.notes ?? ''); setTerms(inv.terms ?? '');
      }).catch(() => toast.error('That invoice could not be read'));
    } else if (cloneId) {
      recurringInvoices.get(cloneId).then((p) => {
        setCustomerId(p.customerId); setName(`${p.name} (copy)`); setOrderNumber(p.orderNumber ?? '');
        setChoice(repeatChoice(p.frequency, p.every)); setCustomEvery(p.every); setCustomUnit(p.frequency);
        setPaymentTerms(p.paymentTerms ?? 'due_on_receipt'); setSalespersonId(p.salespersonId ?? '');
        setLines(p.lines.map(toEditor)); setNotes(p.notes ?? ''); setTerms(p.terms ?? ''); setAsDraft(p.createAsDraft); setAutoSend(p.autoSend);
      }).catch(() => toast.error('That profile could not be copied'));
    }
  }, [editing, params]);

  const customer = s.contacts.find((c) => c.id === customerId);
  const branch = s.branches.find((b) => b.id === (editing?.branchId ?? s.activeBranchId)) ?? s.branches[0];
  const supplyType = useMemo(() => (customer && branch
    ? resolveSupplyType({ branchStateCode: branch.stateCode, placeOfSupply: placeOfSupplyFor({ billToState: customer.stateCode ?? branch.stateCode, servicesOnly: false }), customerTreatment: customer.gstTreatment })
    : 'intra'), [customer, branch]);
  const totals = useMemo(() => {
    const parts = lines.map((l) => computeLineTax({ ratePaise: l.ratePaise, qty: l.qty, discountPct: effectiveDiscountPct(l), gstRatePct: l.gstRatePct, cessRatePct: l.cessRatePct, supplyType }));
    const sub = parts.reduce((t, p) => t + p.taxable, 0);
    return { sub, total: parts.reduce((t, p) => t + p.total, 0) };
  }, [lines, supplyType]);
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
    setErrors(problems);
    if (problems.length) return;
    setSaving(true);
    const payload = {
      customerId, name: name.trim(), orderNumber: orderNumber || null, frequency: repeat.frequency, every: repeat.every,
      startDate, endDate: neverExpires ? null : endDate || null, paymentTerms, salespersonId: salespersonId || null,
      notes: notes || null, terms: terms || null, createAsDraft: asDraft, autoSend, autoRun,
      // A discount is kept in the rate: the template carries the price as agreed.
      lines: filled.map((l) => ({
        itemId: l.itemId, description: l.description || null, qty: l.qty,
        ratePaise: Math.round(l.ratePaise * (1 - effectiveDiscountPct(l) / 100)), gstRatePct: l.gstRatePct, hsnSac: l.hsnSac || null,
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
      </div>

      <div className="space-y-2" data-slot="recurring-items">
        <p className="text-[15px] font-medium">Item Table</p>
        <LineItemsEditor docDate={startDate} lines={lines} onChange={setLines} supplyType={supplyType} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div><label className="mb-1 block text-[13px] text-field-label">Customer Notes</label>
            <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Will be displayed on the invoice" /></div>
          <div><label className="mb-1 block text-[13px] text-field-label">Terms &amp; Conditions</label>
            <Textarea rows={3} value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="Enter the terms and conditions of your business to be displayed in your transaction" /></div>
        </div>
        <div className="space-y-2 self-start rounded-[var(--radius-card)] bg-muted/30 p-4 text-[13px]" data-slot="recurring-totals">
          <div className="flex justify-between"><span>Sub Total</span><Money value={totals.sub} /></div>
          <div className="flex justify-between"><span>Tax</span><Money value={totals.total - totals.sub} /></div>
          <div className="flex justify-between border-t pt-2 font-semibold"><span>Total</span><Money value={totals.total} /></div>
        </div>
      </div>

      <div className="space-y-2 rounded-[var(--radius-card)] border p-4 text-[13px]" data-slot="recurring-preferences">
        <label className="flex items-center gap-2"><Checkbox checked={asDraft} onCheckedChange={(v) => setAsDraft(v === true)} data-slot="create-as-draft" />
          <span><span className="text-muted-foreground">Preferences : </span>Create Invoices as Drafts</span></label>
        <label className="flex items-center gap-2"><Checkbox checked={autoSend} disabled={asDraft} onCheckedChange={(v) => setAutoSend(v === true)} />
          Send each invoice to the customer when it is created</label>
        <label className="flex items-center gap-2"><Checkbox checked={autoRun} onCheckedChange={(v) => setAutoRun(v === true)} />
          Create each invoice on its date by itself (otherwise press Create Invoice)</label>
      </div>
    </DocumentForm>
  );
}
