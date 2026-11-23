'use client';

// New and Edit for a quote, sales order, delivery challan or credit note, as a
// page — Zoho Books' form, not a window over the list (recorded from Zoho's
// demo, 2026-11-23): the customer and, once chosen, their billing and shipping
// addresses and GST details under the name; the place of supply; the number,
// Reference# and dates; the item table; Customer Notes, Terms & Conditions and
// the files; and Zoho's buttons along the bottom with its own messages when
// something is missing.
//
// The server decides the tax, the number and (for a credit note) the entry;
// the totals here are a preview of what it will work out.

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { FileText, Loader2, Pencil, Save, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Combobox } from '@/components/ui/combobox';
import { DocumentForm, FormErrors, FormRow, FormRowPair, FormSectionRule } from '@/components/shared/form-layout';
import { LineItemsEditor, effectiveDiscountPct, newEditorLine, type EditorLine } from '@/components/forms/document-lines';
import { QuickContactDialog } from '@/components/forms/quick-create';
import { PendingAttachments, uploadPending } from '@/components/shared/attachments';
import { GST_TREATMENTS } from '@/components/contacts/contact-form';
import { useAppStore } from '@/lib/store';
import { localDay } from '@/lib/selectors';
import { customerOptions, termsOptions, userOptions } from '@/lib/options';
import { useApi } from '@/lib/api/use-api';
import {
  api, ApiError, invoices as invoiceApi, projects as projectsApi, salesDocuments,
  type AttachableType, type EditableSalesDoc,
} from '@/lib/api/client';
import {
  GST_STATES, STATE_ALPHA, computeLineTax, placeOfSupplyFor, resolveSupplyType, stateTaxLabel, sumTax, totalTaxPaise,
} from '@/lib/tax/gst';
import { formatINR, roundToRupee } from '@/lib/money';
import type { Contact, ContactAddress } from '@/lib/types';
import { ATTACH_TARGET, CHALLAN_TYPES, CREDIT_REASONS, SALES_DOC, type SalesDocKindZ } from './sales-docs';

const today = () => localDay(new Date());
const plusDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return localDay(d);
};

/** "[TN] - Tamil Nadu", as Zoho's Place of Supply lists the states. */
const PLACES = Object.entries(GST_STATES).filter(([code]) => code !== '96')
  .map(([code, name]) => ({ value: code, label: `[${STATE_ALPHA[code] ?? code}] - ${name}`, name }))
  .sort((a, b) => a.name.localeCompare(b.name));

/** Zoho's delivery methods are typed in and remembered; these start the list. */
const DELIVERY_METHODS = ['Courier', 'By Road', 'By Air', 'By Rail', 'By Sea', 'Hand Delivery', 'Pickup by Customer'];

interface PriceList { id: string; name: string; basis: string; percent: number; isActive: boolean; items: { itemId: string; ratePaise: number }[] }

/** "PriceBook-1 [ 19.000000% Markup ]", as Zoho labels a price list. */
const priceListLabel = (l: PriceList) =>
  l.basis === 'percent' ? `${l.name} [ ${Math.abs(l.percent).toFixed(6)}% ${l.percent >= 0 ? 'Markup' : 'Markdown'} ]` : l.name;

function linesFrom(doc: Pick<EditableSalesDoc, 'lines'>, prefix: string): EditorLine[] {
  return doc.lines.map((l, i) => ({
    ...newEditorLine(`${prefix}${i}`),
    itemId: l.itemId, description: l.description ?? '', hsnSac: l.hsnSac ?? '', qty: l.qty, uqc: l.uqc ?? '',
    ratePaise: l.ratePaise, discountPct: l.discountPct, gstRatePct: l.gstRatePct,
  }));
}

/** The customer's addresses and GST details under their name, as Zoho shows them once chosen. */
function CustomerPanel({ c }: { c: Contact }) {
  const block = (title: string, a: ContactAddress | undefined) => (
    <div className="min-w-0">
      <p className="mb-1 text-[12px] uppercase text-muted-foreground">{title}</p>
      {a && (a.line1 || a.city) ? (
        <div className="text-[13px] leading-relaxed">
          <p className="font-medium">{c.displayName}</p>
          {a.line1 && <p className="whitespace-pre-line">{a.line1}</p>}
          {(a.city || a.pincode) && <p>{[a.city, a.pincode].filter(Boolean).join(' ')}</p>}
          {a.stateCode && GST_STATES[a.stateCode] && <p>{GST_STATES[a.stateCode]}</p>}
          {c.phone && <p>Phone: {c.phone}</p>}
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">No address added.</p>
      )}
    </div>
  );
  const treatment = GST_TREATMENTS.find((t) => t.value === c.gstTreatment)?.label ?? c.gstTreatment;
  return (
    <div className="mt-3 space-y-4" data-slot="customer-panel">
      <div className="grid gap-6 sm:grid-cols-2">
        {block('Billing Address', c.billingAddress)}
        {block('Shipping Address', c.shippingAddress ?? c.billingAddress)}
      </div>
      {c.remarks && (
        <div>
          <p className="text-[12px] uppercase text-muted-foreground">Remarks</p>
          <p className="text-[13px]">{c.remarks}</p>
        </div>
      )}
      <div>
        <p className="mb-1 text-[12px] uppercase text-muted-foreground">Billing Recipient GST Details</p>
        <p className="text-[13px]"><span className="text-muted-foreground">GST Treatment: </span>{treatment}</p>
        {c.gstin && <p className="text-[12px]"><span className="text-muted-foreground">GSTIN: </span>{c.gstin}</p>}
      </div>
    </div>
  );
}

export function SalesDocumentForm({ kind, editing }: {
  kind: SalesDocKindZ;
  /** Zoho's Edit: the document as saved, shown and saved back over it. */
  editing?: EditableSalesDoc;
}) {
  const info = SALES_DOC[kind];
  const router = useRouter();
  const params = useSearchParams();
  const s = useAppStore();
  const ed = editing ?? null;
  const isQuote = kind === 'estimate';
  const isOrder = kind === 'sales-order';
  const isChallan = kind === 'challan';
  const isCredit = kind === 'credit-note';

  const [branchId] = useState(ed?.branchId ?? (s.activeBranchId || s.branches[0]?.id || ''));
  const [customerId, setCustomerId] = useState(ed?.customerId ?? '');
  const [newCustomerName, setNewCustomerName] = useState<string | null>(null);
  const [placeOfSupply, setPlaceOfSupply] = useState(ed?.placeOfSupply ?? '');
  // Until picked by hand, the place of supply follows the customer, as Zoho's does.
  const [posTouched, setPosTouched] = useState(!!ed);
  const [referenceNumber, setReferenceNumber] = useState(ed?.referenceNumber ?? '');
  const [date, setDate] = useState(ed?.date ?? today());
  const [expiryDate, setExpiryDate] = useState(ed?.expiryDate ?? plusDays(today(), 15));
  const [expectedShipDate, setExpectedShipDate] = useState(ed?.expectedShipDate ?? '');
  const [paymentTerms, setPaymentTerms] = useState(ed?.paymentTerms ?? 'due_on_receipt');
  const [deliveryMethod, setDeliveryMethod] = useState(ed?.deliveryMethod ?? '');
  const [salespersonId, setSalespersonId] = useState(ed?.salespersonId ?? '');
  const [projectId, setProjectId] = useState(ed?.projectId ?? '');
  const [challanType, setChallanType] = useState(ed?.challanType ?? '');
  const [reason, setReason] = useState(ed?.reason ?? '');
  const [againstInvoiceId, setAgainstInvoiceId] = useState(ed?.againstInvoiceId ?? '');
  const [priceListId, setPriceListId] = useState('');
  const [lines, setLines] = useState<EditorLine[]>(ed ? linesFrom(ed, 'e') : [newEditorLine('l1')]);
  const [notes, setNotes] = useState(ed?.notes ?? '');
  const [terms, setTerms] = useState(ed?.terms ?? '');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState<false | 'draft' | 'send' | 'save'>(false);

  // The number this one will get (peeked, not taken); an edit keeps its own.
  const next = useApi<{ number: string }>(
    // Today's date is left out of the question, so the online demo's recording answers it on any day.
    () => (ed ? Promise.resolve({ number: ed.number }) : api.get('/api/sales-documents/next', { kind, date: date === today() ? undefined : date, branchId: branchId || undefined })),
    [kind, ed?.number, date, branchId],
  );

  // Clone (?clone=), and a credit note for an invoice (?invoice=, the invoice's
  // ⋯ → Create Credit Note): the form starts from that document, as Zoho's does.
  const cloneId = params.get('clone');
  const fromInvoice = isCredit ? params.get('invoice') : null;
  useEffect(() => {
    if (ed || !cloneId) return;
    let live = true;
    salesDocuments.getOne(kind, cloneId).then((d) => {
      if (!live) return;
      setCustomerId(d.customerId);
      if (d.placeOfSupply) { setPlaceOfSupply(d.placeOfSupply); setPosTouched(true); }
      setReferenceNumber(d.referenceNumber ?? '');
      setSalespersonId(d.salespersonId ?? '');
      setProjectId(d.projectId ?? '');
      setPaymentTerms(d.paymentTerms ?? 'due_on_receipt');
      setDeliveryMethod(d.deliveryMethod ?? '');
      setChallanType(d.challanType ?? '');
      setReason(d.reason ?? '');
      setNotes(d.notes ?? '');
      setTerms(d.terms ?? '');
      setLines(linesFrom(d, 'c'));
      toast.info(`Copied from ${d.number}`, { description: 'Dated today with the next number. Check it before saving.' });
    }).catch(() => toast.error(`The ${info.lower} to copy could not be loaded.`));
    return () => { live = false; };
  }, [cloneId, ed, kind, info.lower]);
  useEffect(() => {
    if (ed || !fromInvoice) return;
    let live = true;
    invoiceApi.get(fromInvoice).then((inv) => {
      if (!live) return;
      setCustomerId(inv.customer.id);
      setAgainstInvoiceId(inv.id);
      if (inv.placeOfSupply) { setPlaceOfSupply(inv.placeOfSupply); setPosTouched(true); }
      setReason((r) => r || 'Sales Return');
      setLines(inv.lines.map((l, i) => ({
        ...newEditorLine(`i${i}`),
        itemId: l.itemId, description: l.description ?? '', hsnSac: l.hsnSac ?? '', qty: l.qty, uqc: l.uqc ?? '',
        ratePaise: l.ratePaise, discountPct: l.discountPct, gstRatePct: l.gstRatePct,
      })));
    }).catch(() => toast.error('That invoice could not be loaded.'));
    return () => { live = false; };
  }, [fromInvoice, ed]);

  const customer = s.contacts.find((c) => c.id === customerId);
  const customers = useMemo(() => customerOptions(s), [s]);
  const salespeople = useMemo(() => userOptions(s), [s]);
  const branch = s.branches.find((b) => b.id === branchId);

  const projectList = useApi(
    () => (isQuote && customerId ? projectsApi.list({ status: 'active', customerId }) : Promise.resolve({ projects: [] })),
    [isQuote, customerId],
  );
  const theirInvoices = useApi(
    () => (isCredit && customerId ? invoiceApi.list({ customerId, limit: 200 }) : Promise.resolve({ invoices: [] as { id: string; number: string; date: string; status: string; totalPaise: number; balancePaise: number }[] })),
    [isCredit, customerId],
  );
  const invoiceOptions = useMemo(
    () => (theirInvoices.data?.invoices ?? []).filter((i) => i.status !== 'draft' && i.status !== 'void')
      .map((i) => ({ value: i.id, label: i.number, sublabel: `${i.date} · balance ${formatINR(i.balancePaise)}` })),
    [theirInvoices.data],
  );

  // Prices: the list picked here, else the customer's own list (as the invoice form prices).
  const lists = useApi<{ lists: PriceList[] }>(() => api.get('/api/price-lists'), []);
  const activeLists = (lists.data?.lists ?? []).filter((l) => l.isActive);
  const customerPrices = useApi<{ prices: Record<string, number> | null }>(
    () => (customerId ? api.get('/api/price-lists', { contactId: customerId }) : Promise.resolve({ prices: null })),
    [customerId],
  );
  const picked = activeLists.find((l) => l.id === priceListId);
  const priceFor = (itemId: string): number | undefined => {
    if (picked) {
      if (picked.basis === 'percent') {
        const item = s.items.find((i) => i.id === itemId);
        return item ? Math.round(item.salePricePaise * (1 + picked.percent / 100)) : undefined;
      }
      return picked.items.find((i) => i.itemId === itemId)?.ratePaise;
    }
    return customerPrices.data?.prices?.[itemId];
  };

  const autoPos = customer ? placeOfSupplyFor({ billToState: customer.stateCode, shipToState: null, shipToThirdParty: false, servicesOnly: false }) : '';
  const pos = (posTouched && placeOfSupply) || autoPos;
  const supplyType = useMemo(
    () => (customer && branch
      ? resolveSupplyType({ branchStateCode: branch.stateCode, placeOfSupply: pos, customerTreatment: customer.gstTreatment })
      : 'intra'),
    [customer, branch, pos],
  );

  const onCustomer = (id: string) => {
    setCustomerId(id);
    setPosTouched(false);
    setAgainstInvoiceId('');
    setProjectId('');
    const c = s.contacts.find((x) => x.id === id);
    if (c && isOrder && c.paymentTermsDays != null) {
      const t = termsOptions().find((o) => o.value === `net_${c.paymentTermsDays}`);
      if (t) setPaymentTerms(t.value);
    }
  };

  // The totals as the server will work them out (a challan carries no GST: its goods' value only).
  const totals = useMemo(() => {
    if (isChallan) {
      const value = lines.reduce((t, l) => t + Math.round(l.ratePaise * l.qty), 0);
      return { sub: value, discount: 0, taxable: value, tax: null, roundOff: 0, total: value, qty: lines.reduce((t, l) => t + (l.qty || 0), 0) };
    }
    const tax = sumTax(lines.map((l) => computeLineTax({
      ratePaise: l.ratePaise, qty: l.qty, discountPct: effectiveDiscountPct(l), gstRatePct: l.gstRatePct, cessRatePct: l.cessRatePct, supplyType,
    }).tax));
    const sub = lines.reduce((t, l) => t + Math.round(l.ratePaise * l.qty), 0);
    const { rounded, roundOff } = roundToRupee(tax.taxablePaise + totalTaxPaise(tax));
    return { sub, discount: sub - tax.taxablePaise, taxable: tax.taxablePaise, tax, roundOff, total: rounded, qty: lines.reduce((t, l) => t + (l.qty || 0), 0) };
  }, [lines, supplyType, isChallan]);

  /** Zoho's own messages, in the pink box at the top. */
  const problems = (): string[] => {
    const out: string[] = [];
    if (!customerId) out.push('Select a customer.');
    if (!lines.some((l) => l.qty > 0 && (l.itemId || l.description.trim()))) out.push('Enter the valid item name or description.');
    if ((isQuote || isOrder) && customerId && !pos) out.push('Please select a place of supply');
    if (isChallan && !challanType) out.push('Please choose an appropriate Challan type.');
    if (isCredit && !reason) out.push('Please select a reason for issuing the credit note.');
    if (isQuote && expiryDate && expiryDate < date) out.push('The expiry date cannot be earlier than the quote date.');
    return out;
  };

  const save = async (mode: 'draft' | 'send' | 'save') => {
    const found = problems();
    setErrors(found);
    if (found.length) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    setSaving(mode);
    const kept = lines.filter((l) => l.qty > 0 && (l.itemId || l.description.trim()));
    const common = {
      kind, branchId, customerId, date,
      placeOfSupply: posTouched && pos ? pos : undefined,
      notes: notes.trim() || null, terms: terms.trim() || null,
      referenceNumber: referenceNumber.trim() || null,
    };
    const taxedLines = kept.map((l) => ({
      itemId: l.itemId, description: l.description || null, hsnSac: l.hsnSac || undefined, qty: l.qty, uqc: l.uqc || undefined,
      ratePaise: l.ratePaise, discountPct: effectiveDiscountPct(l), gstRatePct: l.gstRatePct, cessRatePct: l.cessRatePct,
    }));
    const payload = isQuote
      ? { ...common, expiryDate, salespersonId: salespersonId || null, projectId: projectId || null, lines: taxedLines, ...(ed ? {} : { status: mode === 'draft' ? 'draft' : 'sent' }) }
      : isOrder
        ? { ...common, expectedShipDate: expectedShipDate || null, paymentTerms, deliveryMethod: deliveryMethod || null, salespersonId: salespersonId || null, lines: taxedLines, ...(ed ? {} : { status: mode === 'draft' ? 'draft' : 'open' }) }
        : isChallan
          ? { ...common, challanType, lines: kept.map((l) => ({ itemId: l.itemId, description: l.description || null, hsnSac: l.hsnSac || undefined, qty: l.qty, uqc: l.uqc || undefined, ratePaise: l.ratePaise })), ...(ed ? {} : { status: 'draft' }) }
          : { ...common, reason, againstInvoiceId: againstInvoiceId || null, salespersonId: salespersonId || null, lines: taxedLines };
    try {
      const done = ed ? await salesDocuments.update(kind, ed.id, payload) : await salesDocuments.create(payload);
      await uploadPending(ATTACH_TARGET[kind] as AttachableType, done.id, pendingFiles);
      // Save and Send on a draft: a quote goes to sent, an order to confirmed.
      if (ed && mode === 'send' && ed.status === 'draft' && (isQuote || isOrder)) {
        await salesDocuments.setStatus(kind, done.id, isQuote ? 'sent' : 'open').catch(() => toast.warning('Saved, but its status did not change.'));
      }
      toast.success(`${info.noun} ${done.number} ${ed ? 'updated' : mode === 'draft' ? 'saved as draft' : 'saved'}`, {
        description: isCredit
          ? (ed ? 'Its entry was reversed and posted again; the audit trail keeps the old version.' : 'Revenue and the GST on it are reversed; the customer owes that much less.')
          : `A ${info.lower} posts nothing to the ledger.`,
      });
      router.push(`${info.base}/${done.id}`);
    } catch (err) {
      setSaving(false);
      const message = err instanceof ApiError ? err.message : `The ${info.lower} was not saved.`;
      setErrors([message]);
      toast.error(message);
    }
  };

  const title = ed ? `Edit ${info.noun}` : `New ${info.noun}`;
  const busy = !!saving;
  const spin = (m: 'draft' | 'send' | 'save') => (saving === m ? <Loader2 className="size-4 animate-spin" /> : null);
  // Zoho's bottom bar for each: Edit is Save (and Save and Send for a draft quote or order).
  const footer = (
    <>
      {ed ? (
        <>
          <Button onClick={() => void save('save')} disabled={busy} className="gap-1.5" data-slot="doc-save">{spin('save') ?? <Save className="size-4" />} Save</Button>
          {(isQuote || isOrder) && ed.status === 'draft' && (
            <Button variant="outline" onClick={() => void save('send')} disabled={busy} className="gap-1.5" data-slot="doc-save-send">{spin('send') ?? <Send className="size-4" />} Save and Send</Button>
          )}
        </>
      ) : isCredit ? (
        <Button onClick={() => void save('save')} disabled={busy} className="gap-1.5" data-slot="doc-save-open">{spin('save') ?? <Save className="size-4" />} Save as Open</Button>
      ) : (
        <>
          <Button variant="outline" onClick={() => void save('draft')} disabled={busy} className="gap-1.5" data-slot="doc-save-draft">{spin('draft') ?? <Save className="size-4" />} Save as Draft</Button>
          {!isChallan && <Button onClick={() => void save('send')} disabled={busy} className="gap-1.5" data-slot="doc-save-send">{spin('send') ?? <Send className="size-4" />} Save and Send</Button>}
        </>
      )}
      <Button variant="ghost" onClick={() => router.push(ed ? `${info.base}/${ed.id}` : info.base)} disabled={busy}>Cancel</Button>
    </>
  );

  return (
    <DocumentForm
      title={title}
      icon={ed ? <Pencil className="size-5 text-muted-foreground" /> : <FileText className="size-5 text-muted-foreground" />}
      backHref={ed ? `${info.base}/${ed.id}` : info.base}
      footer={footer}
      footerSummary={
        <>
          <p className="text-sm"><span className="text-muted-foreground">Total Amount: </span><span className="font-semibold tabular">{formatINR(totals.total)}</span></p>
          <p className="text-[11px] text-muted-foreground">Total Quantity: <span className="tabular">{totals.qty}</span></p>
        </>
      }
    >
      <FormErrors errors={errors} onClose={() => setErrors([])} />

      <div className="space-y-4" data-slot={`${kind}-form`}>
        <FormRow label="Customer Name" required width="lg">
          <Combobox
            options={customers} value={customerId} onChange={onCustomer}
            placeholder="Select or add a customer" searchPlaceholder="Search customers by name or GSTIN"
            createLabel="New customer" onCreate={(q) => setNewCustomerName(q)} clearable
          />
          {customer && <CustomerPanel c={customer} />}
        </FormRow>

        {(customer || isQuote || isChallan) && (
          <FormRow label="Place of Supply" required={!isChallan}>
            <Combobox
              options={PLACES} value={pos} onChange={(v) => { setPlaceOfSupply(v); setPosTouched(true); }}
              placeholder="" searchPlaceholder="Search states" showAvatar={false}
            />
          </FormRow>
        )}

        {isCredit && customer && (
          <FormRow label="Invoice#" hint="The invoice this credit note is against; leave it blank to keep the credit on the customer’s account.">
            <Combobox options={invoiceOptions} value={againstInvoiceId} onChange={setAgainstInvoiceId}
              placeholder="Select an invoice" searchPlaceholder="Search invoice numbers" showAvatar={false} clearable />
          </FormRow>
        )}

        {isCredit && (
          <FormRow label="Reason" required>
            <Combobox
              options={[...new Set([...CREDIT_REASONS, reason].filter(Boolean))].map((r) => ({ value: r, label: r }))}
              value={reason} onChange={setReason} placeholder="Select a reason" showAvatar={false}
            />
          </FormRow>
        )}
      </div>

      <FormSectionRule />

      <div className="space-y-4">
        <FormRow label={info.numberLabel} required hint={ed ? undefined : 'Numbered automatically in its series when saved.'}>
          <Input value={next.data?.number ?? ''} readOnly className="font-mono" data-slot="doc-number" />
        </FormRow>
        <FormRow label="Reference#" help="Use this field to record any transaction numbers related to this transaction such as purchase order numbers.">
          <Input value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} />
        </FormRow>
        <FormRowPair>
          <FormRow label={info.dateLabel} required>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </FormRow>
          {isQuote && (
            <FormRow label="Expiry Date">
              <Input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
            </FormRow>
          )}
          {isOrder && (
            <FormRow label="Expected Shipment Date">
              <Input type="date" value={expectedShipDate} onChange={(e) => setExpectedShipDate(e.target.value)} />
            </FormRow>
          )}
        </FormRowPair>
        {isOrder && (
          <FormRowPair>
            <FormRow label="Payment Terms">
              <Combobox options={termsOptions()} value={paymentTerms} onChange={setPaymentTerms} showAvatar={false} searchPlaceholder="Search terms" />
            </FormRow>
            <FormRow label="Delivery Method">
              <Combobox
                options={[...new Set([...DELIVERY_METHODS, deliveryMethod].filter(Boolean))].map((m) => ({ value: m, label: m }))}
                value={deliveryMethod} onChange={setDeliveryMethod} placeholder="Select a delivery method or type to add"
                createLabel="Add" onCreate={(q) => setDeliveryMethod(q.trim())} showAvatar={false} clearable
              />
            </FormRow>
          </FormRowPair>
        )}
        {isChallan && (
          <FormRow label="Challan Type" required hint="Choose a proper challan type.">
            <Combobox options={CHALLAN_TYPES} value={challanType} onChange={setChallanType} placeholder="Choose a proper challan type." showAvatar={false} />
          </FormRow>
        )}
        {!isChallan && (
          <FormRow label="Salesperson">
            <Combobox options={salespeople} value={salespersonId} onChange={setSalespersonId} placeholder="Select or Add Salesperson" searchPlaceholder="Search people" clearable />
          </FormRow>
        )}
        {isQuote && (
          <FormRow label="Project Name">
            <Combobox
              options={(projectList.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))}
              value={projectId} onChange={setProjectId}
              placeholder={customerId ? 'Select a project' : 'Select a customer first'} showAvatar={false} clearable
            />
          </FormRow>
        )}
        <FormRow label="Select Price List">
          <Combobox
            options={activeLists.map((l) => ({ value: l.id, label: priceListLabel(l) }))}
            value={priceListId} onChange={setPriceListId} placeholder="Select Price List" showAvatar={false} clearable
          />
        </FormRow>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold">Item Table</h2>
        <LineItemsEditor docDate={date} lines={lines} onChange={setLines} priceFor={priceFor} supplyType={supplyType} />
        {isChallan && <p className="text-xs text-muted-foreground">A delivery challan moves goods without selling them: it carries their value, and no GST.</p>}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-[13px] text-field-label">Customer Notes</label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
              placeholder={isQuote || isCredit ? `Will be displayed on the ${info.lower}` : 'Enter any notes to be displayed in your transaction'} />
          </div>
          <div>
            <label className="mb-1 block text-[13px] text-field-label">Terms &amp; Conditions</label>
            <Textarea value={terms} onChange={(e) => setTerms(e.target.value)} rows={3}
              placeholder="Enter the terms and conditions of your business to be displayed in your transaction" />
          </div>
          <PendingAttachments value={pendingFiles} onChange={setPendingFiles} label={info.attachLabel} />
        </div>

        <div className="rounded-md border bg-muted/30 p-4" data-slot="doc-totals">
          <dl className="space-y-2 text-sm">
            <div className="flex items-center justify-between"><dt className="text-muted-foreground">Sub Total</dt><dd className="tabular">{formatINR(totals.sub)}</dd></div>
            {totals.discount > 0 && (
              <div className="flex items-center justify-between"><dt className="text-muted-foreground">Discount</dt><dd className="tabular text-destructive">−{formatINR(totals.discount)}</dd></div>
            )}
            {totals.tax && totals.tax.cgstPaise > 0 && (
              <>
                <div className="flex items-center justify-between"><dt className="text-muted-foreground">CGST</dt><dd className="tabular">{formatINR(totals.tax.cgstPaise)}</dd></div>
                <div className="flex items-center justify-between"><dt className="text-muted-foreground">{stateTaxLabel(pos)}</dt><dd className="tabular">{formatINR(totals.tax.sgstPaise)}</dd></div>
              </>
            )}
            {totals.tax && totals.tax.igstPaise > 0 && (
              <div className="flex items-center justify-between"><dt className="text-muted-foreground">IGST</dt><dd className="tabular">{formatINR(totals.tax.igstPaise)}</dd></div>
            )}
            {totals.roundOff !== 0 && (
              <div className="flex items-center justify-between"><dt className="text-muted-foreground">Round Off</dt><dd className="tabular">{formatINR(totals.roundOff)}</dd></div>
            )}
            <div className="flex items-center justify-between border-t pt-2.5 text-base font-semibold"><dt>Total ( ₹ )</dt><dd className="tabular">{formatINR(totals.total)}</dd></div>
          </dl>
        </div>
      </div>

      <QuickContactDialog
        kind="customer"
        open={newCustomerName !== null}
        onOpenChange={(o) => !o && setNewCustomerName(null)}
        initialName={newCustomerName ?? ''}
        onCreated={onCustomer}
      />
    </DocumentForm>
  );
}
