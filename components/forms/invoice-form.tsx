'use client';

// The invoice form, and the two documents built on it: a sales receipt (a sale
// paid at the counter, recorded with its receipt) and a debit note (an invoice
// that charged too little, CGST Act s.34(3)). The server decides the tax, the
// number and the entry; this is a preview of them.

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  FileText, Info, Loader2, Save, Send, Settings2,
} from 'lucide-react';
import { toast } from 'sonner';
import { toastWarnings } from '@/lib/api/warnings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import {
  DocumentForm, FormRow, FormRowPair, FormSectionRule,
} from '@/components/shared/form-layout';
import {
  LineItemsEditor, effectiveDiscountPct, newEditorLine, serialsOf, type EditorLine,
} from '@/components/forms/document-lines';
import { SupplyKindPicker } from '@/components/forms/supply-kind-picker';
import { QuickContactDialog } from '@/components/forms/quick-create';
import { useAppStore } from '@/lib/store';
import { today } from '@/lib/selectors';
import {
  branchOptionsForUser, customerOptions, dueDateFor, stateOptions, termsForDays,
  termsOptions, userBranches, userOptions,
} from '@/lib/options';
import { api, ApiError, invoices as invoiceApi, taxRates, type ExpenseListItem } from '@/lib/api/client';
import type { ContactAddress } from '@/components/shared/contact-addresses';
import { PendingAttachments, uploadPending } from '@/components/shared/attachments';
import { useApi } from '@/lib/api/use-api';
import {
  computeLineTax, exportPaysIgstByDefault, isExportSupply, lutGap, placeOfSupplyFor, resolveSupplyType, stateName, stateTaxLabel, sumTax,
  supplyTypeLabel, totalTaxPaise,
} from '@/lib/tax/gst';
import { dayLabel } from '@/lib/date-range';
import { cn } from '@/lib/utils';
import { formatINR, roundToRupee, toRupees } from '@/lib/money';
import type { SupplyKind } from '@/lib/types';
import { CostCentrePicker } from '@/components/forms/cost-centre-picker';
import { GodownPicker } from '@/components/forms/godown-picker';

export type InvoiceVariant = 'invoice' | 'receipt' | 'debit_note';

const VARIANT = {
  invoice: { title: 'New Invoice', noun: 'Invoice', back: '/sales/invoices' },
  receipt: { title: 'New Sales Receipt', noun: 'Sales receipt', back: '/sales/sales-receipts' },
  debit_note: { title: 'New Debit Note', noun: 'Debit note', back: '/sales/debit-notes' },
} as const;

const MODES = [
  { value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'card', label: 'Card' },
  { value: 'neft', label: 'NEFT' }, { value: 'imps', label: 'IMPS' }, { value: 'rtgs', label: 'RTGS' },
  { value: 'cheque', label: 'Cheque' }, { value: 'netbanking', label: 'Net banking' }, { value: 'other', label: 'Other' },
];

export function InvoiceForm({ variant = 'invoice' }: { variant?: InvoiceVariant }) {
  const router = useRouter();
  const s = useAppStore();
  const v = VARIANT[variant];
  const debitNote = variant === 'debit_note';
  // ?clone=<id>: a copy of an earlier invoice to start from, dated today, numbered afresh.
  const cloneId = useSearchParams().get('clone');

  const [branchId, setBranchId] = useState(s.activeBranchId || s.branches[0]?.id || '');
  const [customerId, setCustomerId] = useState('');
  // Non-null while the inline "New customer" dialog is open; holds whatever
  // was typed into the picker, so the dialog opens with the name already in it.
  const [newCustomerName, setNewCustomerName] = useState<string | null>(null);
  const [number, setNumber] = useState('');
  const [orderNumber, setOrderNumber] = useState('');
  const [date, setDate] = useState(today());
  const [paymentTerms, setPaymentTerms] = useState('net_30');
  const [dueDate, setDueDate] = useState(dueDateFor('net_30', today()));
  const [salespersonId, setSalespersonId] = useState('');
  const [subject, setSubject] = useState('');
  const [placeOfSupply, setPlaceOfSupply] = useState('');
  // Until somebody picks a place of supply by hand, it follows the rule: the
  // customer for services, the ship-to for goods (section 10, IGST Act).
  const [posTouched, setPosTouched] = useState(false);
  const [ship, setShip] = useState({ on: false, name: '', address: '', city: '', pincode: '', stateCode: '', thirdParty: false, gstin: '' });
  const [exportDetails, setExportDetails] = useState({ shippingBillNo: '', shippingBillDate: '', portCode: '' });
  // Priced in another currency: rates are typed in it, and the server books rupees at the rate.
  const [currency, setCurrency] = useState('INR');
  const [voucherTypeId, setVoucherTypeId] = useState('');
  const [costCentreId, setCostCentreId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const voucherTypes = useApi<{ types: { id: string; docType: string; name: string; prefix: string; isActive: boolean }[] }>(() => api.get('/api/voucher-types'), []);
  const invoiceTypes = (voucherTypes.data?.types ?? []).filter((t) => t.docType === 'INV' && t.isActive);
  const [fxRate, setFxRate] = useState('');
  // A business that supplies only services starts on services (Settings → Organisation).
  const [supplyKind, setSupplyKind] = useState<SupplyKind>(s.org?.trade?.supplies === 'services' ? 'service' : 'goods');
  // An export's IGST, picked by hand: true paid, false nil under the LUT. Null follows the organisation's setting.
  const [exportChoice, setExportChoice] = useState<boolean | null>(null);
  const [lines, setLines] = useState<EditorLine[]>([newEditorLine('l1')]);
  // The company's own wording when it has set some (Settings → Invoice print).
  const [notes, setNotes] = useState(s.invoiceDefaults.notes ?? 'Thanks for your business.');
  const [terms, setTerms] = useState(
    s.invoiceDefaults.terms ?? 'Goods once sold will not be taken back. Interest @18% p.a. on overdue amounts.',
  );
  const [shipping, setShipping] = useState(0);
  const [adjustment, setAdjustment] = useState(0);
  const [adjustmentLabel, setAdjustmentLabel] = useState('Adjustment');
  // The TCS head this sale is collected under, if any. The rate is the book's,
  // in force on the invoice date; the server works the amount out again.
  const [tcsCode, setTcsCode] = useState('');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [markPaid, setMarkPaid] = useState(variant === 'receipt');
  const [paidMode, setPaidMode] = useState('cash');
  const [paidBankId, setPaidBankId] = useState('');
  const [paidRef, setPaidRef] = useState('');
  const [againstInvoiceId, setAgainstInvoiceId] = useState('');
  const [noteReason, setNoteReason] = useState('');
  const [saving, setSaving] = useState<false | 'draft' | 'send'>(false);

  // Zoho shows the number that will actually be used, not a placeholder.
  // Peeked from the real sequence by /api/masters, so the number shown here is
  // the one the invoice will be given. Computing it locally would drift the
  // moment anyone else raised a document.
  // A debit note's number comes from its own series when it is saved.
  const nextNumber = debitNote ? '' : s.nextNumbers.invoice ?? '';

  // Where the money paid at the counter goes: cash in hand, or a bank account.
  const masters = useApi<{ bankAccounts: { id: string; name: string; kind: string }[] }>(
    () => (markPaid ? api.get('/api/masters') : Promise.resolve({ bankAccounts: [] })), [markPaid],
  );
  const bankOptions = useMemo(
    () => (masters.data?.bankAccounts ?? []).map((b) => ({ value: b.id, label: b.name, sublabel: b.kind })),
    [masters.data],
  );
  useEffect(() => {
    if (!markPaid || paidBankId || !bankOptions.length) return;
    // Cash goes to the cash account, if there is one; anything else to the first bank.
    const cash = (masters.data?.bankAccounts ?? []).find((b) => b.kind === 'cash');
    setPaidBankId(paidMode === 'cash' && cash ? cash.id : bankOptions[0].value);
  }, [markPaid, paidBankId, bankOptions, paidMode, masters.data]);

  // Only meaningful when this user is attached to more than one registration.
  const allowedBranches = useMemo(() => userBranches(s), [s]);
  const multiBranch = allowedBranches.length > 1;

  const customers = useMemo(() => customerOptions(s), [s]);
  const branches = useMemo(() => branchOptionsForUser(s), [s]);
  const salespeople = useMemo(() => userOptions(s), [s]);
  const states = useMemo(() => stateOptions(), []);

  const customer = s.contacts.find((c) => c.id === customerId);
  const addressState = useApi(
    () => (customerId ? api.get<{ addresses: ContactAddress[] }>(`/api/contacts/${customerId}/addresses`) : Promise.resolve({ addresses: [] as ContactAddress[] })),
    [customerId],
  );
  const savedAddresses = addressState.data?.addresses ?? [];

  // TCS heads in force on the invoice date. TCS on ordinary sales of goods
  // ended on 1 April 2025; what remains is collected on particular goods.
  const rates = useApi(() => taxRates.get(date), [date]);
  const tcsHeads = useMemo(() => rates.data?.tcsOn ?? [], [rates.data]);
  const branch = s.branches.find((b) => b.id === branchId);
  const autoPos = customer
    ? placeOfSupplyFor({
        billToState: customer.stateCode,
        shipToState: ship.on ? ship.stateCode || null : null,
        shipToThirdParty: ship.thirdParty,
        servicesOnly: supplyKind === 'service',
      })
    : '';
  const pos = (posTouched && placeOfSupply) || autoPos;
  const isExport = customer?.gstTreatment === 'overseas' || customer?.gstTreatment === 'sez';
  const foreign = currency !== 'INR';
  // A customer on a price list is charged from it as items are picked.
  const prices = useApi<{ prices: Record<string, number> | null; discounts: { itemId: string | null; minQty: number; discountPct: number }[] | null }>(
    () => (customerId ? api.get('/api/price-lists', { contactId: customerId }) : Promise.resolve({ prices: null, discounts: null })),
    [customerId],
  );
  // A customer invoiced in their own currency brings it with them.
  useEffect(() => { setCurrency(customer?.currency ?? 'INR'); }, [customer?.id, customer?.currency]);
  const rate = Number(fxRate) || 0;
  /** A figure on this form, in the invoice's own currency. */
  const money = (p: number) => (foreign ? new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(p / 100) : formatINR(p));

  // Picking a customer pulls their default payment terms through, like Zoho.
  const onCustomerChange = (id: string) => {
    setCustomerId(id);
    const c = s.contacts.find((x) => x.id === id);
    if (!c) return;
    const t = termsForDays(c.paymentTermsDays);
    setPaymentTerms(t);
    setDueDate(dueDateFor(t, date));
    setPlaceOfSupply(c.stateCode);
    setPosTouched(false);
    // A new customer starts from the organisation's setting again.
    setExportChoice(null);
    // What they buy narrows the items offered: a services-only customer sees services.
    if (c.supplies) setSupplyKind(c.supplies);
  };
  const onPosChange = (v: string) => {
    setPlaceOfSupply(v);
    setPosTouched(true);
  };

  const onTermsChange = (t: string) => {
    setPaymentTerms(t);
    setDueDate(dueDateFor(t, date));
  };

  const onDateChange = (d: string) => {
    setDate(d);
    setDueDate(dueDateFor(paymentTerms, d));
  };

  // The customer's issued invoices, for the one a debit note corrects.
  const theirInvoices = useApi<{ invoices: { id: string; number: string; date: string; totalPaise: number; supplyType?: string }[] }>(
    () => (debitNote && customerId ? api.get('/api/invoices', { customerId, kind: 'invoice', limit: 200 }) : Promise.resolve({ invoices: [] })),
    [debitNote, customerId],
  );

  // An export goes with IGST nil only under a LUT in force on its date;
  // otherwise IGST is paid on it and claimed back (Settings → Organisation).
  // A debit note is part of the export it corrects, and takes its IGST.
  const trade = s.org?.trade;
  const exporting = !!customer && (s.org?.gstRegistrationType ?? 'regular') === 'regular' && isExportSupply(customer.gstTreatment, pos);
  const corrected = debitNote ? (theirInvoices.data?.invoices ?? []).find((i) => i.id === againstInvoiceId) : undefined;
  const followsInvoice = corrected?.supplyType === 'export_lut' || corrected?.supplyType === 'export_with_tax';
  const lutMissing = exporting && !followsInvoice ? lutGap(trade, date) : null;
  const exportWithTax = !exporting ? undefined
    : followsInvoice ? corrected!.supplyType === 'export_with_tax'
    : (exportChoice === false && lutMissing ? true : exportChoice ?? exportPaysIgstByDefault(trade, date));
  const supplyType = useMemo(
    () =>
      customer && branch
        ? resolveSupplyType({
            branchStateCode: branch.stateCode,
            placeOfSupply: pos,
            customerTreatment: customer.gstTreatment,
            exportWithTax,
          })
        : 'intra',
    [customer, branch, pos, exportWithTax],
  );

  const totals = useMemo(() => {
    const parts = lines.map(
      (l) =>
        computeLineTax({
          ratePaise: l.ratePaise,
          qty: l.qty,
          discountPct: effectiveDiscountPct(l),
          gstRatePct: l.gstRatePct,
          cessRatePct: l.cessRatePct,
          supplyType,
        }).tax,
    );
    const tax = sumTax(parts);
    const grossBeforeDiscount = lines.reduce((t, l) => t + Math.round(l.ratePaise * l.qty), 0);
    const discount = grossBeforeDiscount - tax.taxablePaise;
    const tcsRate = tcsCode ? tcsHeads.find((h) => h.code === tcsCode) : undefined;
    const tcsBase = tax.taxablePaise + totalTaxPaise(tax) + shipping + adjustment;
    const tcs = tcsRate && (tcsRate.thresholdPaise === null || tcsBase > tcsRate.thresholdPaise)
      ? Math.round((tcsBase * (customer?.pan ? tcsRate.ratePct : tcsRate.rateNoPanPct)) / 100)
      : 0;
    const beforeRound =
      tax.taxablePaise + totalTaxPaise(tax) + shipping + adjustment + tcs;
    const { rounded, roundOff } = roundToRupee(beforeRound);
    const qty = lines.reduce((t, l) => t + (l.qty || 0), 0);
    return { tax, discount, grossBeforeDiscount, tcs, rounded, roundOff, qty };
  }, [lines, supplyType, shipping, adjustment, tcsCode, tcsHeads, customer]);

  const invoiceOptions = useMemo(
    () => (theirInvoices.data?.invoices ?? []).map((i) => ({ value: i.id, label: i.number, sublabel: `${i.date} · ${formatINR(i.totalPaise)}` })),
    [theirInvoices.data],
  );

  // The customer's billable expenses not yet re-charged (outside projects, which bill their own).
  const billables = useApi<{ expenses: ExpenseListItem[] }>(
    () => (customerId && !debitNote ? api.get('/api/expenses', { unbilledFor: customerId, limit: 100 }) : Promise.resolve({ expenses: [] })),
    [customerId, debitNote],
  );
  const chargeKey = (id: string) => `x${id}`;
  const charged = lines.filter((l) => l.key.startsWith('x')).map((l) => l.key.slice(1));
  const pendingCharges = (billables.data?.expenses ?? []).filter((x) => !charged.includes(x.id));
  const addCharges = () => {
    setLines((prev) => [
      // A blank first line is dropped rather than left above the charges.
      ...prev.filter((l) => l.itemId || l.description || l.ratePaise > 0),
      ...pendingCharges.map((x) => ({
        ...newEditorLine(chargeKey(x.id)),
        description: `Re-charge: ${x.notes || x.accountName} (${x.number}, ${String(x.date).slice(0, 10)})`,
        // At what it cost: net when the credit was claimed, gross when it was blocked.
        ratePaise: x.itcEligibility === 'ineligible' ? x.totalPaise : x.amountPaise,
        gstRatePct: 18,
      })),
    ]);
  };

  useEffect(() => {
    if (!cloneId) return;
    let live = true;
    invoiceApi.get(cloneId).then((inv) => {
      if (!live) return;
      setCustomerId(inv.customer.id);
      setPlaceOfSupply(inv.placeOfSupply);
      setSubject(inv.subject ?? '');
      if (inv.paymentTerms) { setPaymentTerms(inv.paymentTerms); setDueDate(dueDateFor(inv.paymentTerms, today())); }
      if (inv.notes) setNotes(inv.notes);
      if (inv.terms) setTerms(inv.terms);
      setSupplyKind(inv.supplyKind as SupplyKind);
      if (inv.supplyType === 'export_with_tax' || inv.supplyType === 'export_lut') setExportChoice(inv.supplyType === 'export_with_tax');
      setLines(inv.lines.map((l, i) => ({
        ...newEditorLine(`c${i}`),
        itemId: l.itemId, description: l.description ?? '', hsnSac: l.hsnSac ?? '', qty: l.qty, uqc: l.uqc ?? '',
        ratePaise: l.ratePaise, discountPct: l.discountPct, gstRatePct: l.gstRatePct,
      })));
      toast.info(`Copied from ${inv.number}`, { description: 'Dated today with the next number. Check it before saving.' });
    }).catch(() => toast.error('The invoice to copy could not be loaded.'));
    return () => { live = false; };
  }, [cloneId]);

  const valid = !!customerId && lines.some((l) => l.qty > 0 && l.ratePaise > 0) && (!foreign || rate > 0);

  const save = async (mode: 'draft' | 'send') => {
    if (!valid) {
      toast.error('Add a customer and at least one item', {
        description: 'An invoice needs a customer and one line with a quantity and rate.',
      });
      return;
    }
    if (markPaid && mode === 'draft') {
      toast.error('A draft is not a sale yet', { description: "Save it as issued to record the payment with it, or untick 'I have received the payment'." });
      return;
    }
    if (markPaid && !paidBankId) {
      toast.error('Pick where the money went', { description: 'Cash in hand, or the bank account it was paid into.' });
      return;
    }
    if (debitNote && !noteReason.trim()) {
      toast.error('Say why the debit note is raised', { description: 'For example, a price revised upward, or goods short-billed.' });
      return;
    }
    setSaving(mode);

    // The server recomputes GST, allocates the number and posts the entry in
    // one transaction. The totals shown above are a preview of that, not the
    // source of it — a browser must never be the thing that decides what tax
    // an invoice carries.
    const created = await api
      .post<{ id: string; number: string; totalPaise: number; journalEntryId: string | null }>(
        '/api/invoices',
        {
          branchId,
          customerId,
          date,
          dueDate,
          // Sent only when picked by hand; otherwise the server applies the
          // same rule to the ship-to, from what the lines actually are.
          placeOfSupply: posTouched ? pos : undefined,
          shipTo: ship.on && ship.stateCode
            ? {
                name: ship.name || null, address: ship.address || null, city: ship.city || null,
                pincode: ship.pincode || null, stateCode: ship.stateCode, thirdParty: ship.thirdParty, gstin: ship.gstin || null,
              }
            : null,
          ...(foreign ? { currency, exchangeRate: rate } : {}),
          voucherTypeId: (!debitNote && voucherTypeId) || undefined,
          docKind: debitNote ? 'debit_note' : undefined,
          againstInvoiceId: debitNote ? againstInvoiceId || null : undefined,
          noteReason: debitNote ? noteReason.trim() : undefined,
          paidAtSale: markPaid ? { mode: paidMode, bankAccountId: paidBankId, reference: paidRef || null } : undefined,
          billExpenseIds: charged.length ? charged : undefined,
          costCentreId: costCentreId || undefined,
          warehouseId: warehouseId || undefined,
          exportDetails: isExport && (exportDetails.shippingBillNo || exportDetails.portCode)
            ? {
                shippingBillNo: exportDetails.shippingBillNo || null,
                shippingBillDate: exportDetails.shippingBillDate || null,
                portCode: exportDetails.portCode || null,
              }
            : null,
          supplyKind,
          // A debit note's IGST is the corrected invoice's; the server takes it from there.
          exportWithTax: followsInvoice ? undefined : exportWithTax,
          status: mode === 'draft' ? 'draft' : 'approved',
          number: number && number !== nextNumber ? number : undefined,
          orderNumber: orderNumber || undefined,
          subject: subject || undefined,
          paymentTerms,
          salespersonId: salespersonId || undefined,
          notes,
          terms,
          shippingChargePaise: shipping,
          adjustmentPaise: adjustment,
          adjustmentLabel,
          tcsCode: tcsCode || null,
          lines: lines
            .filter((l) => l.qty > 0)
            .map((l) => ({
              itemId: l.itemId,
              description: l.description,
              hsnSac: l.hsnSac || undefined,
              qty: l.qty,
              uqc: l.uqc,
              ratePaise: l.ratePaise,
              discountPct: effectiveDiscountPct(l),
              gstRatePct: l.gstRatePct,
              cessRatePct: l.cessRatePct,
              batchId: l.batchId || undefined,
              serials: serialsOf(l),
            })),
        },
      )
      .catch((err: unknown) => {
        setSaving(false);
        if (err instanceof ApiError && err.isQueued) {
          toast.success('Kept on this device', { description: 'It will be sent when you are back online.' });
          router.push(v.back);
          return null;
        }
        const message = err instanceof ApiError ? err.message : 'Could not save the invoice.';
        toast.error(message, {
          description:
            err instanceof ApiError && err.details
              ? Object.values(err.details).join(' ')
              : 'Nothing was saved.',
        });
        return null;
      });

    if (!created) return;
    await uploadPending('invoice', created.id, pendingFiles);

    if (mode === 'send') {
      await api.post(`/api/invoices/${created.id}`, { action: 'send' }).catch(() => {
        // Posted either way; only the "sent" flag failed to stick.
        toast.warning('Saved, but could not mark it as sent.');
      });
    }

    toastWarnings(created);
    toast.success(`${v.noun} ${created.number} ${mode === 'draft' ? 'saved as draft' : markPaid ? 'saved, with its receipt' : 'saved and sent'}`, {
      description:
        mode === 'draft'
          ? 'Drafts stay out of the ledger until you approve them.'
          : markPaid
            ? 'The sale and the money are both in the ledger, and the invoice is settled.'
            : 'Posted to the ledger — open the Journal tab to see the entry.',
    });
    router.push(`/sales/invoices/${created.id}`);
  };

  return (
    <DocumentForm
      title={v.title}
      icon={<FileText className="size-5 text-muted-foreground" />}
      backHref={v.back}
      headerExtra={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Invoice preferences"
          onClick={() => toast.info('Invoice preferences', { description: 'Numbering, templates and defaults live in Settings.' })}
        >
          <Settings2 className="size-4" />
        </Button>
      }
      footer={
        <>
          <Button variant="outline" onClick={() => save('draft')} disabled={!!saving} className="gap-1.5">
            {saving === 'draft' ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save as Draft
          </Button>
          <Button onClick={() => save('send')} disabled={!!saving} className="gap-1.5">
            {saving === 'send' ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Save and Send
          </Button>
          <Button variant="ghost" onClick={() => router.push(v.back)} disabled={!!saving}>
            Cancel
          </Button>
        </>
      }
      footerSummary={
        <>
          <p className="text-sm">
            <span className="text-muted-foreground">Total Amount: </span>
            <span className="font-semibold tabular">{formatINR(totals.rounded)}</span>
          </p>
          <p className="text-[11px] text-muted-foreground">
            Total Quantity: <span className="tabular">{totals.qty}</span>
          </p>
        </>
      }
    >
      {/* ── Header fields ─────────────────────────────────────────────── */}
      <div className="space-y-4">
        <FormRow label="Customer Name" required width="lg">
          <Combobox
            options={customers}
            value={customerId}
            onChange={onCustomerChange}
            placeholder="Select or add a customer"
            searchPlaceholder="Search customers by name or GSTIN"
            createLabel="New customer"
            onCreate={(q) => setNewCustomerName(q)}
            clearable
          />
          {customer && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary" className="text-[10px] capitalize">
                {customer.gstTreatment.replace(/_/g, ' ')}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {stateName(customer.stateCode)}
              </Badge>
              {customer.creditLimit && (
                <Badge variant="outline" className="text-[10px]">
                  Credit limit {formatINR(customer.creditLimit)}
                </Badge>
              )}
              {customer.customerDeductsTds && (
                <Badge variant="outline" className="border-amber-500/40 text-[10px]">
                  Deducts TDS
                </Badge>
              )}
            </div>
          )}
          {pendingCharges.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2 text-xs" data-slot="unbilled-expenses">
              <span>
                {pendingCharges.length} billable expense{pendingCharges.length > 1 ? 's' : ''} not yet re-charged to {customer?.displayName ?? 'this customer'}
                {' '}({formatINR(pendingCharges.reduce((t, x) => t + (x.itcEligibility === 'ineligible' ? x.totalPaise : x.amountPaise), 0))} at cost)
              </span>
              <Button size="sm" variant="outline" onClick={addCharges}>Add to this invoice</Button>
            </div>
          )}
        </FormRow>

        {debitNote && (
          <FormRowPair>
            <FormRow label="Against invoice" hint="The invoice this corrects. Rule 53(1A) wants it named on the note.">
              <Combobox options={invoiceOptions} value={againstInvoiceId} onChange={setAgainstInvoiceId}
                placeholder={customerId ? 'Pick the invoice' : 'Pick the customer first'} searchPlaceholder="Search invoice numbers" showAvatar={false} clearable />
            </FormRow>
            <FormRow label="Reason" required>
              <Input value={noteReason} onChange={(e) => setNoteReason(e.target.value)} placeholder="Price revised upward, goods short-billed…" />
            </FormRow>
          </FormRowPair>
        )}

        <FormRowPair>
          <FormRow label={debitNote ? 'Debit Note#' : 'Invoice#'} required={!debitNote}>
            <Input
              value={number || nextNumber}
              onChange={(e) => setNumber(e.target.value)}
              placeholder={debitNote ? 'Next in the DN series' : undefined}
              className="font-mono"
            />
          </FormRow>
          <FormRow label="Order Number">
            <Input
              value={orderNumber}
              onChange={(e) => setOrderNumber(e.target.value)}
              placeholder="Customer PO reference"
            />
          </FormRow>
        </FormRowPair>

        <FormRowPair>
          <FormRow label={debitNote ? 'Date' : 'Invoice Date'} required>
            <Input type="date" value={date} onChange={(e) => onDateChange(e.target.value)} />
          </FormRow>
          <FormRow label="Terms">
            <Combobox
              options={termsOptions()}
              value={paymentTerms}
              onChange={onTermsChange}
              placeholder="Select terms"
              showAvatar={false}
              searchPlaceholder="Search terms"
            />
          </FormRow>
        </FormRowPair>

        <FormRowPair>
          <FormRow label="Due Date">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </FormRow>
          <FormRow label="Salesperson">
            <Combobox
              options={salespeople}
              value={salespersonId}
              onChange={setSalespersonId}
              placeholder="Select a salesperson"
              searchPlaceholder="Search people"
              clearable
            />
          </FormRow>
        </FormRowPair>

        <FormRow label="Subject" width="lg" hint="A short line summarising what this invoice is for">
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="What this invoice is for"
          />
        </FormRow>

        <FormSectionRule label="GST" />

        <FormRow
          label="Invoice For"
          required
          width="lg"
          hint="Goods take an HSN code, services take a SAC. Pick both for a mixed invoice."
        >
          <SupplyKindPicker value={supplyKind} onChange={setSupplyKind} />
        </FormRow>

        {/*
          Branch only appears when the business actually holds more than one GST
          registration — otherwise there is nothing to choose and the field is
          noise. Zoho behaves the same way: no Branch field until Branches is
          enabled and a second registration exists. Single-branch orgs get the
          branch implicitly from the top-bar switcher.
        */}
        {multiBranch ? (
          <FormRowPair>
            <FormRow
              label="Branch (GSTIN)"
              required
              hint="Which of your GST registrations raises this invoice"
            >
              <Combobox
                options={branches}
                value={branchId}
                onChange={setBranchId}
                placeholder="Select branch"
                searchPlaceholder="Search branches"
              />
            </FormRow>
            <FormRow label="Place of Supply" required>
              <Combobox
                options={states}
                value={pos}
                onChange={onPosChange}
                placeholder="Select state"
                searchPlaceholder="Search states"
                showAvatar={false}
              />
            </FormRow>
          </FormRowPair>
        ) : (
          <FormRow
            label="Place of Supply"
            required
            hint={branch ? `Supplying from ${branch.gstin}` : undefined}
          >
            <Combobox
              options={states}
              value={pos}
              onChange={onPosChange}
              placeholder="Select state"
              searchPlaceholder="Search states"
              showAvatar={false}
            />
          </FormRow>
        )}

        <FormRow label="Ship to" hint="Where the goods go, when not to the customer's own address">
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={ship.on} onCheckedChange={(v) => {
                // Turning it on starts from the customer's default delivery address, when they have one.
                const d = v && !ship.address ? savedAddresses.find((a) => a.isDefault) : undefined;
                setShip(d ? { ...ship, on: true, name: d.name ?? '', address: d.address, city: d.city ?? '', pincode: d.pincode ?? '', stateCode: d.stateCode, gstin: d.gstin ?? '' } : { ...ship, on: !!v });
              }} />
              Deliver to a different address
            </label>
            {ship.on && (
              <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">
                {savedAddresses.length > 0 && (
                  <select aria-label="Saved addresses" value="" className="h-9 rounded-md border border-input bg-background px-2 text-sm sm:col-span-2"
                    onChange={(e) => { const a = savedAddresses.find((x) => x.id === e.target.value); if (a) setShip({ ...ship, name: a.name ?? '', address: a.address, city: a.city ?? '', pincode: a.pincode ?? '', stateCode: a.stateCode, gstin: a.gstin ?? '' }); }}>
                    <option value="">Use one of {customer?.displayName ?? 'the customer'}&apos;s saved addresses…</option>
                    {savedAddresses.map((a) => <option key={a.id} value={a.id}>{a.label}{a.city ? ` — ${a.city}` : ''}</option>)}
                  </select>
                )}
                <Input placeholder="Name at the delivery address" value={ship.name} onChange={(e) => setShip({ ...ship, name: e.target.value })} />
                <Combobox options={states} value={ship.stateCode} onChange={(v) => setShip({ ...ship, stateCode: v })} placeholder="State" showAvatar={false} />
                <Input placeholder="Address" value={ship.address} onChange={(e) => setShip({ ...ship, address: e.target.value })} className="sm:col-span-2" />
                <Input placeholder="City" value={ship.city} onChange={(e) => setShip({ ...ship, city: e.target.value })} />
                <Input placeholder="PIN code" value={ship.pincode} onChange={(e) => setShip({ ...ship, pincode: e.target.value.replace(/\D/g, '').slice(0, 6) })} />
                <label className="flex items-start gap-2 text-xs text-muted-foreground sm:col-span-2">
                  <Checkbox checked={ship.thirdParty} onCheckedChange={(v) => setShip({ ...ship, thirdParty: !!v })} />
                  <span>
                    Delivered to someone else on the customer&apos;s instruction (bill to one, ship to another). The place of
                    supply then stays the customer&apos;s state; otherwise goods are supplied where they are delivered.
                  </span>
                </label>
              </div>
            )}
          </div>
        </FormRow>

        <CostCentrePicker as="row" value={costCentreId} onChange={setCostCentreId} />
        <GodownPicker as="row" branchId={branchId} value={warehouseId} onChange={setWarehouseId} />

        {!debitNote && invoiceTypes.length > 0 && (
          <FormRow label="Voucher type" hint="Numbered in that type's own series">
            <select value={voucherTypeId} onChange={(e) => setVoucherTypeId(e.target.value)}
              className="h-9 w-full max-w-xs rounded-md border border-input bg-background px-2 text-sm">
              <option value="">Invoice (INV series)</option>
              {invoiceTypes.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.prefix} series)</option>)}
            </select>
          </FormRow>
        )}

        {(isExport || foreign) && (
          <FormRow label="Currency" hint="Price an export in the buyer’s currency; it is booked in rupees at the rate on the date of supply (Rule 34)">
            <div className="grid gap-2 sm:grid-cols-3">
              <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'INR')} className="font-mono" maxLength={3} />
              {foreign && <Input type="number" step="0.0001" min={0} placeholder={`₹ for 1 ${currency}`} value={fxRate} onChange={(e) => setFxRate(e.target.value)} />}
              {foreign && rate > 0 && <span className="self-center text-xs text-muted-foreground">≈ {formatINR(Math.round(totals.rounded * rate))} in the books</span>}
            </div>
          </FormRow>
        )}

        {exporting && followsInvoice && (
          <FormRow label="IGST on this export" hint="A debit note takes the IGST of the invoice it corrects">
            <p className="text-sm" data-slot="export-igst-follows">
              As {corrected!.number}: {exportWithTax ? 'IGST paid' : 'under LUT — IGST nil'}
            </p>
          </FormRow>
        )}

        {exporting && !followsInvoice && (
          <FormRow label="IGST on this export" required width="lg" hint="Nil under a Letter of Undertaking, or paid and claimed back as a refund">
            <div className="space-y-2">
              <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="IGST on this export" data-slot="export-igst">
                {[
                  { v: false, label: 'Under LUT — IGST nil', hint: lutMissing ? `${lutMissing}.` : `LUT ${trade?.lutArn}, ${dayLabel(trade?.lutValidFrom ?? '')} to ${dayLabel(trade?.lutValidTo ?? '')}` },
                  { v: true, label: 'IGST paid', hint: 'Charged at the item rates and claimed back as a refund' },
                ].map((o) => (
                  <button key={String(o.v)} type="button" role="radio" aria-checked={exportWithTax === o.v} disabled={!o.v && !!lutMissing}
                    onClick={() => setExportChoice(o.v)}
                    className={cn('rounded-md border p-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                      exportWithTax === o.v ? 'border-primary bg-primary/5' : 'hover:bg-accent/50')}>
                    <span className="block text-sm font-medium">{o.label}</span>
                    <span className="block text-xs text-muted-foreground">{o.hint}</span>
                  </button>
                ))}
              </div>
              {trade?.tradeScope === 'domestic' && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  Settings → Organisation says this business sells within India only. Set it to domestic and international to export.
                </p>
              )}
            </div>
          </FormRow>
        )}

        {isExport && supplyKind !== 'service' && (
          <FormRow label="Shipping bill" hint="For the IGST refund and GSTR-1; it can be added later from the invoice">
            <div className="grid gap-2 sm:grid-cols-3">
              <Input placeholder="Shipping bill no." value={exportDetails.shippingBillNo} onChange={(e) => setExportDetails({ ...exportDetails, shippingBillNo: e.target.value.replace(/\D/g, '') })} />
              <Input type="date" value={exportDetails.shippingBillDate} onChange={(e) => setExportDetails({ ...exportDetails, shippingBillDate: e.target.value })} />
              <Input placeholder="Port code, e.g. INMAA1" value={exportDetails.portCode} onChange={(e) => setExportDetails({ ...exportDetails, portCode: e.target.value.toUpperCase().slice(0, 6) })} />
            </div>
          </FormRow>
        )}

        {customer && branch && (
          <div className="flex items-start gap-2.5 rounded-md border border-primary/25 bg-primary/5 px-3 py-2.5 sm:ml-[166px]">
            <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />
            <p className="text-xs leading-relaxed">
              <span className="font-medium">{supplyTypeLabel(supplyType)}</span>
              <span className="text-muted-foreground">
                {' — supplying from '}{stateName(branch.stateCode)}{' to '}{stateName(pos)}
                {supplyType === 'intra' && '. Same state, so the tax splits equally between centre and state.'}
                {supplyType === 'inter' && '. Different states, so a single integrated tax applies.'}
                {supplyType === 'export_lut' && `. Exports under LUT are zero-rated: IGST nil${trade?.lutArn ? ` under ${trade.lutArn}` : ''}.`}
                {supplyType === 'export_with_tax' && '. IGST is charged on the export and claimed back as a refund.'}
                {exporting && supplyKind === 'service' && ' An export of services has no shipping bill; it counts as an export once paid in foreign exchange.'}
                {supplyType === 'sez' && '. Supplies to an SEZ unit are zero-rated.'}
              </span>
            </p>
          </div>
        )}
      </div>

      {/* ── Item table ────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold">Item Table</h2>
        <LineItemsEditor
          docDate={date}
          lines={lines}
          onChange={setLines}
          priceFor={foreign ? undefined : (id) => prices.data?.prices?.[id]}
          discountFor={(id, qty) => {
            const rules = prices.data?.discounts;
            if (!rules) return undefined;
            return rules.filter((r) => (r.itemId === null || r.itemId === id) && qty >= r.minQty).reduce((best, r) => Math.max(best, r.discountPct), 0);
          }}
          batchMode="pick"
          supplyType={supplyType}
          supplyKind={supplyKind}
        />
      </div>

      {/* ── Notes + totals ────────────────────────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-[13px] text-field-label">Customer Notes</label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
            <p className="mt-1 text-[11px] text-muted-foreground">Shown on the invoice.</p>
          </div>
          <div>
            <label className="mb-1 block text-[13px] text-field-label">Terms &amp; Conditions</label>
            <Textarea value={terms} onChange={(e) => setTerms(e.target.value)} rows={3} />
          </div>
          <PendingAttachments value={pendingFiles} onChange={setPendingFiles} label="Attach File(s) to Invoice" />
        </div>

        {/* Totals panel */}
        <div className="rounded-md border bg-muted/30 p-4">
          <dl className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Sub Total</dt>
              <dd className="tabular">{formatINR(totals.grossBeforeDiscount)}</dd>
            </div>
            {totals.discount > 0 && (
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Discount</dt>
                <dd className="tabular text-destructive">−{formatINR(totals.discount)}</dd>
              </div>
            )}
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Taxable Value</dt>
              <dd className="tabular">{formatINR(totals.tax.taxablePaise)}</dd>
            </div>

            {totals.tax.cgstPaise > 0 && (
              <>
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">CGST</dt>
                  <dd className="tabular">{formatINR(totals.tax.cgstPaise)}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">{stateTaxLabel(pos)}</dt>
                  <dd className="tabular">{formatINR(totals.tax.sgstPaise)}</dd>
                </div>
              </>
            )}
            {totals.tax.igstPaise > 0 && (
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">IGST</dt>
                <dd className="tabular">{formatINR(totals.tax.igstPaise)}</dd>
              </div>
            )}
            {supplyType === 'export_lut' && (
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">IGST</dt>
                <dd className="text-xs font-medium">Nil (under LUT)</dd>
              </div>
            )}

            {/* Shipping */}
            <div className="flex items-center justify-between gap-3 border-t pt-2">
              <dt className="text-muted-foreground">Shipping Charges</dt>
              <dd>
                <Input
                  type="number"
                  step="0.01"
                  value={shipping === 0 ? '' : toRupees(shipping)}
                  onChange={(e) => setShipping(Math.round(parseFloat(e.target.value || '0') * 100))}
                  placeholder="0.00"
                  className="h-8 w-28 text-right tabular"
                />
              </dd>
            </div>

            {/* Adjustment */}
            <div className="flex items-center justify-between gap-3">
              <dt className="min-w-0 flex-1">
                <Input
                  value={adjustmentLabel}
                  onChange={(e) => setAdjustmentLabel(e.target.value)}
                  className="h-8 max-w-[140px] text-xs"
                />
              </dt>
              <dd>
                <Input
                  type="number"
                  step="0.01"
                  value={adjustment === 0 ? '' : toRupees(adjustment)}
                  onChange={(e) => setAdjustment(Math.round(parseFloat(e.target.value || '0') * 100))}
                  placeholder="0.00"
                  className="h-8 w-28 text-right tabular"
                />
              </dd>
            </div>

            {/* TCS, only on goods that still carry it */}
            <div className="flex items-center justify-between gap-3">
              <dt className="min-w-0 flex-1">
                <Combobox
                  options={[
                    { value: '', label: 'No TCS' },
                    ...tcsHeads.map((h) => ({
                      value: h.code,
                      label: `TCS — ${h.nature}`,
                      sublabel: h.thresholdPaise !== null
                        ? `${h.ratePct}% above ${formatINR(h.thresholdPaise)}`
                        : `${h.ratePct}%`,
                    })),
                  ]}
                  value={tcsCode}
                  onChange={setTcsCode}
                  placeholder="No TCS"
                  showAvatar={false}
                  className="h-8 max-w-[220px] text-xs"
                />
              </dt>
              <dd className="tabular">{formatINR(totals.tcs)}</dd>
            </div>

            {totals.roundOff !== 0 && (
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Round Off</dt>
                <dd className="tabular">{formatINR(totals.roundOff)}</dd>
              </div>
            )}

            <div className="flex items-center justify-between border-t pt-2.5 text-base font-semibold">
              <dt>Total</dt>
              <dd className="tabular">{money(totals.rounded)}</dd>
            </div>
          </dl>

          {!debitNote && variant !== 'receipt' && (
            <label className="mt-4 flex cursor-pointer items-start gap-2 border-t pt-3 text-xs">
              <Checkbox checked={markPaid} onCheckedChange={(c) => setMarkPaid(c === true)} className="mt-0.5" />
              <span className="text-muted-foreground">
                I have received the payment
                <span className="mt-0.5 block text-[11px]">
                  Records the receipt at the same time, so the invoice is created already settled.
                </span>
              </span>
            </label>
          )}
          {markPaid && (
            <div className="mt-3 grid gap-2 border-t pt-3 text-xs" data-slot="paid-at-sale">
              <p className="font-medium">Payment received{variant === 'receipt' ? ' at the counter' : ''}</p>
              <select value={paidMode} onChange={(e) => { setPaidMode(e.target.value); setPaidBankId(''); }} aria-label="Payment mode"
                className="h-8 rounded-md border bg-background px-2 text-xs">
                {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
              <Combobox options={bankOptions} value={paidBankId} onChange={setPaidBankId} placeholder="Deposit to" showAvatar={false} className="h-8 text-xs" />
              <Input value={paidRef} onChange={(e) => setPaidRef(e.target.value)} placeholder="Reference (UPI ref, cheque no.)" className="h-8 text-xs" />
            </div>
          )}
        </div>
      </div>

      {/* Creating a customer without leaving the invoice. onCustomerChange is
          reused rather than a bare setState, so the new customer's payment
          terms and place of supply land on the document just as they would
          have if it had been picked from the list. */}
      <QuickContactDialog
        kind="customer"
        open={newCustomerName !== null}
        onOpenChange={(o) => !o && setNewCustomerName(null)}
        initialName={newCustomerName ?? ''}
        onCreated={onCustomerChange}
      />
    </DocumentForm>
  );
}
