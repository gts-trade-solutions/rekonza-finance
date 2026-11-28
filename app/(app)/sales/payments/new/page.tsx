'use client';

// Zoho Books' "Record Payment" for a customer, recorded from Zoho's demo on
// 2026-11-23: the Invoice Payment / Customer Advance tabs in the title band,
// the customer on its own band, then Amount Received, Bank Charges, Payment
// Date, Payment #, Payment Mode, Deposit To, Reference#, "Tax deducted?", the
// customer's unpaid invoices with a PAYMENT column, Zoho's four-line summary,
// the internal notes and attachments, and Save · Cancel.
//
// What it saves is what the receipt always was: what is typed as Amount
// Received is what the customer paid; with the TDS they kept it settles
// Amount Received + TDS, the bank gets Amount Received − bank charges, and
// whatever is not set against an invoice stays on account as an advance
// ("Amount in Excess").
//
// ?customer=&invoice= arrive from an invoice's Record Payment (the invoice is
// ticked in full); ?edit=<id> is Zoho's Edit (PUT over the saved receipt);
// ?bank= from a bank account's Add Transaction.

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Info, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { toastWarnings } from '@/lib/api/warnings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import { ContactPicker } from '@/components/forms/quick-create';
import { DocumentForm, FormErrors, FormRow } from '@/components/shared/form-layout';
import { MoneyInput } from '@/components/shared/form-bits';
import { Money } from '@/components/shared/money';
import { PendingAttachments, uploadPending } from '@/components/shared/attachments';
import { useAppStore } from '@/lib/store';
import { customers, today } from '@/lib/selectors';
import { api, ApiError, invoices as invoiceApi, openingBalances, payments as paymentsApi, type InvoiceListResponse, type PaymentDetail } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useSession } from '@/components/layout/session-provider';
import { cn } from '@/lib/utils';
import type { PaymentMode } from '@/lib/types';
import { advanceGstField, advanceProblem, advanceQuestionApplies, advanceTaxPaise, defaultAdvanceFor, type AdvanceFor } from '@/lib/gst/advance-for';

const MODES: { value: PaymentMode; label: string }[] = [
  { value: 'cash', label: 'Cash' }, { value: 'neft', label: 'Bank Transfer (NEFT)' }, { value: 'upi', label: 'UPI' },
  { value: 'imps', label: 'IMPS' }, { value: 'cheque', label: 'Cheque' }, { value: 'card', label: 'Credit Card' }, { value: 'gateway', label: 'Online gateway' },
];
const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

function NewPaymentInner() {
  const router = useRouter();
  const params = useSearchParams();
  const s = useAppStore();
  const custList = customers(s);

  // Zoho's two tabs: money against invoices, or an advance before any invoice.
  const [tab, setTab] = useState<'invoice' | 'advance'>('invoice');
  const [customerId, setCustomerId] = useState(params.get('customer') ?? '');
  const [date, setDate] = useState(today());
  const [mode, setMode] = useState<PaymentMode>('neft');
  const [bankAccountId, setBankAccountId] = useState(params.get('bank') ?? '');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [tdsOn, setTdsOn] = useState(false);
  const [tdsPaise, setTdsPaise] = useState(0);
  const [chargesPaise, setChargesPaise] = useState(0);
  // Zoho's Amount Received; until it is typed it follows what is applied.
  const [amountPaise, setAmountPaise] = useState(0);
  const [amountTyped, setAmountTyped] = useState(false);
  const [selected, setSelected] = useState<Record<string, number>>({});
  // What an excess (an advance) is for. GST on an advance for services is due
  // when the money arrives (CGST Act s.13(2)); on goods it is not, since
  // Notification 66/2017-CT. The old tick box was off unless someone ticked
  // it, so an advance for services went untaxed and GSTR-1 table 11A and
  // GSTR-3B 3.1(a) left it out (auditor check, 2026-11-28). Now the question is
  // asked outright, answered in advance for a book that sells only one kind,
  // and a GST-registered book cannot save an advance without an answer.
  const [advanceFor, setAdvanceFor] = useState<AdvanceFor | null>(null);
  const advanceForServices = advanceFor === 'services';
  const [advanceRate, setAdvanceRate] = useState(18);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const session = useSession();

  const editId = params.get('edit');
  const editState = useApi<PaymentDetail | null>(() => (editId ? paymentsApi.get(editId) : Promise.resolve(null)), [editId]);
  const editing = editState.data;
  const filled = useRef(false);

  const customer = custList.find((c) => c.id === customerId);
  // A customer invoiced in another currency pays in it: amounts are in that
  // currency, and the rupees the bank credited are entered separately.
  const fxCurrency = customer?.currency && customer.currency !== 'INR' ? customer.currency : null;
  const [rupeesCredited, setRupeesCredited] = useState(0);

  useEffect(() => {
    if (!editing || filled.current) return;
    filled.current = true;
    setCustomerId(editing.contactId);
    setDate(editing.date);
    if (editing.mode) setMode(editing.mode as PaymentMode);
    if (editing.bankAccountId) setBankAccountId(editing.bankAccountId);
    setReference(editing.reference ?? '');
    setNotes(editing.notes ?? '');
    setTdsOn(editing.tdsPaise > 0);
    setTdsPaise(editing.tdsPaise);
    setChargesPaise(editing.bankChargesPaise ?? 0);
    const sel = Object.fromEntries(editing.allocations
      .filter((a) => a.targetType === 'invoice' || a.targetType === 'opening')
      .map((a) => [a.targetType === 'opening' ? `opening:${a.targetId}` : a.targetId, a.foreignAmountPaise ?? a.amountPaise]));
    setSelected(sel);
    const applied = Object.values(sel).reduce((t, v) => t + v, 0);
    if (editing.currency && editing.currency !== 'INR') {
      setAmountPaise(applied + editing.unappliedPaise);
      setRupeesCredited(editing.amountPaise);
    } else {
      setAmountPaise(editing.amountPaise + (editing.bankChargesPaise ?? 0));
    }
    setAmountTyped(true);
    if (!applied && editing.unappliedPaise > 0) setTab('advance');
    if (editing.advanceGst) { setAdvanceFor('services'); setAdvanceRate(editing.advanceGst.ratePct); }
    else if (editing.unappliedPaise > 0) setAdvanceFor('goods');
  }, [editing]);

  const mastersState = useApi<{ bankAccounts: { id: string; name: string; kind: string }[] }>(() => api.get('/api/masters'), []);
  const bankOptions = useMemo(
    // A credit card cannot receive a customer's money.
    () => (mastersState.data?.bankAccounts ?? []).filter((b) => b.kind !== 'card').map((b) => ({ value: b.id, label: b.name, sublabel: b.kind })),
    [mastersState.data],
  );
  useEffect(() => {
    if (!bankAccountId && bankOptions.length && !editId) setBankAccountId(bankOptions[0].value);
  }, [bankAccountId, bankOptions, editId]);

  // Only this customer's unsettled invoices, oldest first, and openings carried in.
  const openState = useApi<InvoiceListResponse>(
    () => customerId ? invoiceApi.list({ customerId, open: true, limit: 200 }) : Promise.resolve({ invoices: [], statusCounts: {}, summary: { count: 0, totalPaise: 0, duePaise: 0 } }),
    [customerId],
  );
  const openingState = useApi(
    () => customerId ? openingBalances.documents({ contactId: customerId, kind: 'receivable', open: true }) : Promise.resolve({ documents: [] }),
    [customerId],
  );
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const openInvs = useMemo(() => {
    const list: { id: string; number: string; date: string; dueDate: string; totalPaise: number; balancePaise: number }[] = [
      ...(openingState.data?.documents ?? []).map((o) => ({ id: `opening:${o.id}`, number: `Opening ${o.refNo}`, date: o.dueDate, dueDate: o.dueDate, totalPaise: o.balancePaise, balancePaise: o.balancePaise })),
      ...(openState.data?.invoices ?? []).map((i) => ({ id: i.id, number: i.number, date: i.date, dueDate: i.dueDate, totalPaise: i.fcBalancePaise != null ? i.fcBalancePaise : i.totalPaise, balancePaise: i.fcBalancePaise ?? i.balancePaise })),
    ];
    // Editing: what this receipt paid is owed again for the edit.
    for (const a of editing?.allocations ?? []) {
      if (a.targetType !== 'invoice' && a.targetType !== 'opening') continue;
      const key = a.targetType === 'opening' ? `opening:${a.targetId}` : a.targetId;
      const paid = a.foreignAmountPaise ?? a.amountPaise;
      const row = list.find((r) => r.id === key);
      if (row) row.balancePaise += paid;
      else list.push({ id: key, number: a.number, date: a.dueDate ?? editing!.date, dueDate: a.dueDate ?? editing!.date, totalPaise: paid, balancePaise: paid });
    }
    return list.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }, [openState.data, openingState.data, editing]);
  const shown = openInvs.filter((i) => (!from || i.date >= from) && (!to || i.date <= to));

  // Arriving from an invoice's Record Payment: that invoice, in full.
  const preselected = useRef(false);
  useEffect(() => {
    const invId = params.get('invoice');
    if (!invId || preselected.current) return;
    const inv = openInvs.find((i) => i.id === invId);
    if (!inv) return;
    setSelected({ [inv.id]: inv.balancePaise });
    preselected.current = true;
  }, [params, openInvs]);

  const supplies = s.org?.trade?.supplies ?? 'both';
  useEffect(() => {
    if (editId || advanceFor) return;
    const d = defaultAdvanceFor(supplies);
    if (d) setAdvanceFor(d);
  }, [supplies, editId, advanceFor]);

  const advanceTab = tab === 'advance';
  const allocated = advanceTab ? 0 : Object.values(selected).reduce((t, v) => t + v, 0);
  const tds = tdsOn && !fxCurrency ? tdsPaise : 0;
  // Until Amount Received is typed, it is what is applied less the TDS kept.
  const received = amountTyped ? amountPaise : Math.max(0, allocated - tds);
  const settles = received + tds;
  const excess = settles - allocated;
  const cashReceived = fxCurrency ? rupeesCredited : received - chargesPaise;
  const impliedRate = fxCurrency && settles > 0 ? rupeesCredited / settles : 0;
  const advanceCtx = { excessPaise: excess, foreign: !!fxCurrency, gstRegistration: s.org?.gstRegistrationType, advanceFor, ratePct: advanceRate };
  const askAdvance = advanceQuestionApplies(advanceCtx);
  const advanceTax = advanceForServices && excess > 0 ? advanceTaxPaise(excess, advanceRate) : 0;

  const setPayment = (id: string, p: number, bal: number) => setSelected((sel) => {
    const next = { ...sel };
    if (p <= 0) delete next[id]; else next[id] = Math.min(p, bal);
    return next;
  });

  const save = async () => {
    // Zoho's checks, in its words.
    const problems: string[] = [];
    if (!customerId) problems.push('Select a customer.');
    if (received <= 0) problems.push('Enter a valid amount received.');
    if (excess < 0) problems.push('The amount applied to invoices is more than the amount received.');
    if (!bankAccountId) problems.push('Select the account the money was deposited to.');
    if (received > 0 && cashReceived <= 0) problems.push('Bank charges come to more than the amount received.');
    if (fxCurrency && rupeesCredited <= 0) problems.push('Enter the rupees the bank credited.');
    const advanceIssue = advanceProblem(advanceCtx);
    if (advanceIssue) problems.push(advanceIssue);
    setErrors(problems);
    if (problems.length) return;

    setSaving(true);
    const payload = {
      kind: 'received' as const,
      branchId: session.user.branchId ?? session.branches[0]?.id,
      contactId: customerId,
      date,
      mode,
      bankAccountId,
      // The cash figure only: TDS the customer kept never reaches the bank, but still settles the invoice.
      amountPaise: fxCurrency ? rupeesCredited : cashReceived,
      tdsPaise: tds,
      bankChargesPaise: chargesPaise,
      reference: reference || undefined,
      notes: notes.trim() || undefined,
      allocations: advanceTab ? [] : Object.entries(selected).map(([key, amt]) => ({
        targetType: key.startsWith('opening:') ? ('opening' as const) : ('invoice' as const),
        targetId: key.replace(/^opening:/, ''),
        ...(fxCurrency ? { amountPaise: 0, foreignAmountPaise: amt } : { amountPaise: amt }),
      })),
      fx: fxCurrency ? { currency: fxCurrency, rate: Number(impliedRate.toFixed(6)), foreignAmountPaise: settles } : undefined,
      advanceGst: advanceGstField(advanceCtx),
    };
    const created = await (editId
      ? paymentsApi.update(editId, { ...payload, branchId: editing?.branchId ?? payload.branchId })
      : api.post<{ id: string; number: string; unappliedPaise: number }>('/api/payments', payload))
      .catch((err: unknown) => {
        setSaving(false);
        if (err instanceof ApiError && err.isQueued) {
          toast.success('Kept on this device', { description: 'It will be sent when you are back online.' });
          router.push('/sales/payments');
          return null;
        }
        setErrors([err instanceof ApiError ? err.message : 'Could not record the payment.']);
        return null;
      });
    if (!created) return;
    const id = editId ?? created.id;
    if (pendingFiles.length) await uploadPending('payment', id, pendingFiles).catch(() => toast.warning('The payment was saved, but its attachments were not.'));
    toastWarnings(created);
    toast.success(editId ? `Payment ${created.number} updated` : `Payment ${created.number} recorded`, {
      description: created.unappliedPaise > 0 ? `${(created.unappliedPaise / 100).toFixed(2)} is left as an excess payment, on account.` : 'The invoices are settled and its entry posted.',
    });
    router.push(`/sales/payments/${id}`);
  };

  const tabs = (['invoice', 'advance'] as const).map((t) => (
    <button key={t} type="button" onClick={() => setTab(t)} data-slot={`payment-tab-${t}`}
      className={cn('-mb-px border-b-2 px-0.5 text-[16px] transition-colors', tab === t ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
      {t === 'invoice' ? 'Invoice Payment' : 'Customer Advance'}
    </button>
  ));

  return (
    <DocumentForm
      title={editId ? `Edit Payment ${editing?.number ?? ''}` : 'Record Payment'}
      tabs={tabs}
      backHref={editId ? `/sales/payments/${editId}` : '/sales/payments'}
      footer={
        <>
          <Button onClick={() => void save()} disabled={saving || (!!editId && !editing)} data-slot="save-payment">
            {saving && <Loader2 className="size-4 animate-spin" />} Save
          </Button>
          <Button variant="outline" onClick={() => router.push(editId ? `/sales/payments/${editId}` : '/sales/payments')} disabled={saving}>Cancel</Button>
        </>
      }
    >
      <FormErrors errors={errors} onClose={() => setErrors([])} />
      <div className="space-y-4" data-slot="payment-form">
        <FormRow label="Customer Name" required width="lg">
          <ContactPicker kind="customer" value={customerId} onChange={(v) => { setCustomerId(v); setSelected({}); }} />
        </FormRow>
      </div>

      <div className={cn('space-y-4 rounded-[var(--radius-card)] bg-muted/30 p-5', !customerId && 'pointer-events-none opacity-50')}>
        <FormRow label={fxCurrency ? `Amount Received (${fxCurrency})` : 'Amount Received'} required width="lg">
          <MoneyInput valuePaise={received} onChangePaise={(p) => { setAmountTyped(true); setAmountPaise(p); }} data-slot="amount-received" />
        </FormRow>
        {fxCurrency && (
          <FormRow label="Rupees credited by the bank" required width="lg" hint={impliedRate > 0 ? `₹${impliedRate.toFixed(4)} per ${fxCurrency}; the difference from each invoice's rate is an exchange gain or loss.` : undefined}>
            <MoneyInput valuePaise={rupeesCredited} onChangePaise={setRupeesCredited} />
          </FormRow>
        )}
        <FormRow label="Bank Charges (if any)" width="lg">
          <MoneyInput valuePaise={chargesPaise} onChangePaise={setChargesPaise} />
        </FormRow>
        <FormRow label="Payment Date" required width="lg">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </FormRow>
        <FormRow label="Payment #" required width="lg">
          <Input value={editing?.number ?? ''} readOnly placeholder="Given the next number in the series when saved" />
        </FormRow>
        <FormRow label="Payment Mode" width="lg">
          <Combobox options={MODES} value={mode} onChange={(v) => setMode(v as PaymentMode)} showAvatar={false} placeholder="Choose the payment mode" searchPlaceholder="Search modes" />
        </FormRow>
        <FormRow label="Deposit To" required width="lg">
          <Combobox options={bankOptions} value={bankAccountId} onChange={setBankAccountId} placeholder="Select an account" searchPlaceholder="Search accounts" />
        </FormRow>
        <FormRow label="Reference#" width="lg">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </FormRow>
        {!fxCurrency && (
          <FormRow label="Tax deducted?" width="lg">
            <div className="flex flex-wrap items-center gap-5 pt-1.5 text-[13px]" role="radiogroup" data-slot="tax-deducted">
              <label className="flex items-center gap-1.5"><input type="radio" checked={!tdsOn} onChange={() => setTdsOn(false)} /> No Tax deducted</label>
              <label className="flex items-center gap-1.5"><input type="radio" checked={tdsOn} onChange={() => setTdsOn(true)} /> Yes, TDS (Income Tax)</label>
            </div>
          </FormRow>
        )}
        {tdsOn && !fxCurrency && (
          <FormRow label="TDS Amount" width="lg" hint="Kept by the customer and paid to the government for you: booked as TDS Receivable, and the invoice is still settled in full.">
            <MoneyInput valuePaise={tdsPaise} onChangePaise={setTdsPaise} />
          </FormRow>
        )}
      </div>

      {!advanceTab ? (
        <section className={cn('space-y-3', !customerId && 'opacity-50')} data-slot="unpaid-invoices">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-[16px] font-medium">Unpaid Invoices</h2>
            <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              Filter by Date Range
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-7 w-36" aria-label="From" />
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-7 w-36" aria-label="To" />
            </span>
            <button type="button" className="ml-auto text-[13px] text-link hover:underline" onClick={() => setSelected({})} data-slot="clear-applied">Clear Applied Amount</button>
          </div>
          {customer?.billWise === false && (
            <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">This customer is not kept bill-wise. Leave the payments blank and the receipt settles the oldest first.</p>
          )}
          <div className="overflow-x-auto rounded-[var(--radius-card)] border">
            <table className="w-full text-[13px]">
              <thead className="bg-[#f9f9fb] text-[11px] font-semibold uppercase text-[#6c718a]">
                <tr>
                  <th className="px-4 py-2.5 text-left">Date</th>
                  <th className="px-4 py-2.5 text-left">Invoice Number</th>
                  <th className="px-4 py-2.5 text-right">Invoice Amount</th>
                  <th className="px-4 py-2.5 text-right">Amount Due</th>
                  <th className="px-4 py-2.5 text-left">Payment Received On</th>
                  <th className="px-4 py-2.5 text-right">Payment</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">There are no unpaid invoices associated with this customer.</td></tr>
                ) : shown.map((inv) => (
                  <tr key={inv.id} className="border-t">
                    <td className="px-4 py-2.5">{day(inv.date)}<p className="text-[11px] text-muted-foreground">Due on {day(inv.dueDate)}</p></td>
                    <td className="px-4 py-2.5 font-medium">{inv.number}</td>
                    <td className="px-4 py-2.5 text-right">{fxCurrency ? fxMoney(inv.totalPaise, fxCurrency) : <Money value={inv.totalPaise} />}</td>
                    <td className="px-4 py-2.5 text-right">{fxCurrency ? fxMoney(inv.balancePaise, fxCurrency) : <Money value={inv.balancePaise} />}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{selected[inv.id] != null ? day(date) : ''}</td>
                    <td className="px-4 py-2.5">
                      <div className="ml-auto flex max-w-44 items-center justify-end gap-2">
                        <MoneyInput valuePaise={selected[inv.id] ?? 0} onChangePaise={(p) => setPayment(inv.id, p, inv.balancePaise)} className="h-8" />
                        <Checkbox aria-label={`Pay ${inv.number} in full`} checked={selected[inv.id] === inv.balancePaise} onCheckedChange={(v) => setPayment(inv.id, v === true ? inv.balancePaise : 0, inv.balancePaise)} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              {shown.length > 0 && (
                <tfoot><tr className="border-t font-medium"><td colSpan={5} className="px-4 py-2.5 text-right">Total</td><td className="px-4 py-2.5 text-right">{fxCurrency ? fxMoney(allocated, fxCurrency) : <Money value={allocated} />}</td></tr></tfoot>
              )}
            </table>
          </div>
          <p className="text-[11px] text-muted-foreground">**List contains only SENT invoices</p>
        </section>
      ) : (
        <p className="flex items-start gap-2 rounded-md border bg-muted/30 p-3 text-[13px] text-muted-foreground" data-slot="advance-note">
          <Info className="mt-0.5 size-4 shrink-0 text-primary" /> A customer advance is money received before an invoice. It stays on account and is applied to the customer&apos;s invoices later.
        </p>
      )}

      <div className="ml-auto w-full max-w-md space-y-2 rounded-[var(--radius-card)] bg-muted/30 p-4 text-[13px]" data-slot="payment-summary">
        {[
          ['Amount Received :', received],
          ['Amount used for Payments :', allocated],
          ['Amount Refunded :', 0],
        ].map(([label, v]) => (
          <div key={label as string} className="flex justify-between"><span className="text-muted-foreground">{label}</span><span className="tabular">{fxCurrency ? fxMoney(v as number, fxCurrency) : <Money value={v as number} />}</span></div>
        ))}
        <div className={cn('flex justify-between border-t pt-2 font-medium', excess < 0 && 'text-destructive')}>
          <span>Amount in Excess:</span><span className="tabular">{fxCurrency ? fxMoney(excess, fxCurrency) : <Money value={excess} />}</span>
        </div>
        {askAdvance && (
          <div className="space-y-2 border-t pt-2" data-slot="advance-for">
            <p className="font-medium">The <Money value={excess} /> left over is an advance for</p>
            <label className="flex items-start gap-2">
              <input type="radio" name="advance-for" className="mt-1 accent-primary" checked={advanceFor === 'services'} onChange={() => setAdvanceFor('services')} data-slot="advance-for-services" />
              <span>Services: GST is due on it now <span className="text-muted-foreground">(CGST Act s.13(2))</span></span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="advance-for" className="mt-1 accent-primary" checked={advanceFor === 'goods'} onChange={() => setAdvanceFor('goods')} data-slot="advance-for-goods" />
              <span>Goods: no GST until the invoice <span className="text-muted-foreground">(Notification 66/2017-CT)</span></span>
            </label>
            {advanceForServices && (
              <p className="text-[11px] leading-relaxed text-muted-foreground" data-slot="advance-gst">
                GST rate{' '}
                <select className="h-7 rounded border bg-background px-1" value={advanceRate} onChange={(e) => setAdvanceRate(Number(e.target.value))} aria-label="GST rate of the services" data-slot="advance-rate">
                  {[5, 12, 18, 28, 40].map((r) => <option key={r} value={r}>{r}%</option>)}
                </select>
                {' '}· <Money value={advanceTax} /> of it is GST. It is posted now, reported in GSTR-1 table 11A and GSTR-3B 3.1(a) for this month,
                and taken back (table 11B) in the month the advance is applied to an invoice that charges it, so it is not paid twice.
              </p>
            )}
            {advanceFor === null && <p className="text-[11px] text-amber-700" data-slot="advance-for-missing">Choose one: it decides whether GST is due on this receipt.</p>}
          </div>
        )}
      </div>

      <FormRow label="Notes (Internal use. Not visible to customer)" width="full">
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="max-w-[520px]" />
      </FormRow>
      <PendingAttachments value={pendingFiles} onChange={setPendingFiles} label="Attachments" />
    </DocumentForm>
  );
}

/** An amount in another currency, from its minor units. */
const fxMoney = (minor: number, currency: string) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(minor / 100);

export default function NewPaymentPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground">Loading…</div>}>
      <NewPaymentInner />
    </Suspense>
  );
}
