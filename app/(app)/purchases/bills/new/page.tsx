'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { FileText, Loader2, Save, ScanText, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Combobox } from '@/components/ui/combobox';
import {
  DocumentForm, FormRow, FormRowPair, FormSectionRule,
} from '@/components/shared/form-layout';
import {
  LineItemsEditor, effectiveDiscountPct, newEditorLine, serialsOf, type EditorLine,
} from '@/components/forms/document-lines';
import { toastWarnings } from '@/lib/api/warnings';
import { QuickContactDialog } from '@/components/forms/quick-create';
import { useAppStore } from '@/lib/store';
import { today } from '@/lib/selectors';
import {
  branchOptionsForUser, dueDateFor, termsForDays, termsOptions, userBranches,
  vendorOptions,
} from '@/lib/options';
import { api, ApiError, taxRates } from '@/lib/api/client';
import { PendingAttachments, uploadPending } from '@/components/shared/attachments';
import { useApi } from '@/lib/api/use-api';
import { computeLineTax, stateName, sumTax, totalTaxPaise } from '@/lib/tax/gst';
import { computeTds, TDS_SECTIONS } from '@/lib/tax/tds';
import { rateOn } from '@/lib/tax/statutory-rates';
import { formatINR } from '@/lib/money';
import { CostCentrePicker } from '@/components/forms/cost-centre-picker';
import { GodownPicker } from '@/components/forms/godown-picker';

export default function NewBillPage() {
  const router = useRouter();
  const s = useAppStore();

  const [branchId, setBranchId] = useState(s.activeBranchId || s.branches[0]?.id || '');
  const [vendorId, setVendorId] = useState('');
  // Non-null while the inline "New vendor" dialog is open.
  const [newVendorName, setNewVendorName] = useState<string | null>(null);
  const [vendorInvoiceNo, setVendorInvoiceNo] = useState('');
  const [orderNumber, setOrderNumber] = useState('');
  const [date, setDate] = useState(today());
  const [paymentTerms, setPaymentTerms] = useState('net_30');
  const [dueDate, setDueDate] = useState(dueDateFor('net_30', today()));
  const [subject, setSubject] = useState('');
  const [isRcm, setIsRcm] = useState(false);
  const [tdsOverride, setTdsOverride] = useState('');
  const [lines, setLines] = useState<EditorLine[]>([newEditorLine('l1')]);
  const [itc, setItc] = useState<Record<string, 'eligible' | 'ineligible' | 'capital_goods'>>({});
  const [notes, setNotes] = useState('');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [costCentreId, setCostCentreId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  // Read from a PDF or photo: what to check, and a supplier not yet in the books.
  const [reading, setReading] = useState(false);
  const [readNotes, setReadNotes] = useState<string[]>([]);
  const [unmatched, setUnmatched] = useState<{ name: string; gstin: string | null } | null>(null);

  // Only surface the picker when this user has more than one registration.
  const allowedBranches = useMemo(() => userBranches(s), [s]);
  const multiBranch = allowedBranches.length > 1;

  const vendors = useMemo(() => vendorOptions(s), [s]);
  const branches = useMemo(() => branchOptionsForUser(s), [s]);
  // Peeked from the real sequence by /api/masters. Bills are numbered once for
  // the organisation, so the figure does not depend on the branch.
  const internalNo = s.nextNumbers.bill ?? '';

  // What this vendor has already been billed this financial year. TDS
  // thresholds are annual, so a bill is only correctly deducted in the context
  // of everything before it — computing it from this bill alone under-deducts,
  // and the shortfall is recovered from us with interest.
  const vendorSummary = useApi(
    async () =>
      vendorId
        ? api.get<{ summary: { fyTaxablePaise: number } }>(`/api/contacts/${vendorId}?summary=1`)
        : null,
    [vendorId],
  );
  const fyTaxable = vendorSummary.data?.summary.fyTaxablePaise ?? 0;

  // The book's own TDS rates, so the preview deducts what the server will:
  // the rate in force on the bill's date, not a list built into the page.
  const rates = useApi(() => taxRates.get(), []);

  const vendor = s.contacts.find((c) => c.id === vendorId);
  // An overseas supplier billing in their currency: rates are typed in it, booked in rupees at the rate.
  const [currency, setCurrency] = useState('INR');
  const [fxRate, setFxRate] = useState('');
  useEffect(() => { setCurrency(vendor?.currency ?? 'INR'); }, [vendor?.id, vendor?.currency]);
  const foreign = currency !== 'INR';
  const rate = Number(fxRate) || 0;
  const branch = s.branches.find((b) => b.id === branchId);
  const isComposition = vendor?.gstTreatment === 'registered_composition';
  const isUnregistered = vendor?.gstTreatment === 'unregistered';

  const onVendorChange = (id: string) => {
    setVendorId(id);
    const v = s.contacts.find((x) => x.id === id);
    if (!v) return;
    const t = termsForDays(v.paymentTermsDays);
    setPaymentTerms(t);
    setDueDate(dueDateFor(t, date));
    setIsRcm(v.gstTreatment === 'unregistered');
  };

  const onTermsChange = (t: string) => {
    setPaymentTerms(t);
    setDueDate(dueDateFor(t, date));
  };

  const supplyType = useMemo(() => {
    if (isComposition) return 'nil_or_exempt' as const;
    if (!vendor || !branch) return 'intra' as const;
    return vendor.stateCode === branch.stateCode ? ('intra' as const) : ('inter' as const);
  }, [vendor, branch, isComposition]);

  const totals = useMemo(() => {
    const tax = sumTax(
      lines.map(
        (l) =>
          computeLineTax({
            ratePaise: l.ratePaise,
            qty: l.qty,
            discountPct: effectiveDiscountPct(l),
            gstRatePct: isComposition ? 0 : l.gstRatePct,
            cessRatePct: isComposition ? 0 : l.cessRatePct,
            supplyType,
          }).tax,
      ),
    );
    const sectionCode = tdsOverride || vendor?.tdsSection;
    const tds = computeTds({
      rate: sectionCode && rates.data ? rateOn(rates.data.tds, sectionCode, date) : null,
      pan: vendor?.pan,
      billTaxable: tax.taxablePaise,
      fyPaidSoFar: fyTaxable,
    });
    const gross = tax.taxablePaise + (isRcm ? 0 : totalTaxPaise(tax));
    const qty = lines.reduce((t, l) => t + (l.qty || 0), 0);
    return { tax, tds, gross, payable: gross - tds.tdsPaise, qty };
  }, [lines, supplyType, isComposition, vendor, tdsOverride, isRcm, fyTaxable, rates.data, date]);

  const readBill = async (file: File) => {
    setReading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const r = await api.post<{
        bill: { vendorName: string | null; vendorGstin: string | null; invoiceNumber: string | null; invoiceDate: string | null; dueDate: string | null;
          lines: { description: string; hsnSac: string | null; qty: number; ratePaise: number; gstRatePct: number }[] };
        vendor: { id: string; name: string; by: 'gstin' | 'name' } | null; notes: string[]; chargedMc: number;
      }>('/api/bills/capture', form);
      const b = r.bill;
      if (r.vendor) { onVendorChange(r.vendor.id); setUnmatched(null); } else if (b.vendorName) setUnmatched({ name: b.vendorName, gstin: b.vendorGstin });
      if (b.invoiceNumber) setVendorInvoiceNo(b.invoiceNumber);
      if (b.invoiceDate) { setDate(b.invoiceDate); setDueDate(b.dueDate ?? dueDateFor(paymentTerms, b.invoiceDate)); }
      if (b.lines.length) {
        setLines(b.lines.map((l, i) => ({ ...newEditorLine(`read${i}`), description: l.description, hsnSac: l.hsnSac ?? '', qty: l.qty, ratePaise: l.ratePaise, gstRatePct: l.gstRatePct })));
      }
      setPendingFiles((f) => (f.some((x) => x.name === file.name && x.size === file.size) ? f : [...f, file]));
      setReadNotes(r.notes);
      toast.success('Bill read — check it before saving', {
        description: `${b.lines.length} line(s)${r.vendor ? `, supplier ${r.vendor.name}` : ''}. The file will be attached to the bill. ${(r.chargedMc / 1000).toFixed(1)} credits.`,
      });
    } catch (err) {
      toast.error('Could not read that bill', { description: err instanceof ApiError ? err.message : String(err) });
    } finally {
      setReading(false);
    }
  };

  const valid = !!vendorId && !!vendorInvoiceNo.trim() && lines.some((l) => l.qty > 0 && l.ratePaise > 0) && (!foreign || rate > 0);

  const save = async () => {
    if (!valid) {
      toast.error('Missing required details', {
        description: "Pick a vendor, enter their invoice number, and add at least one line.",
      });
      return;
    }
    setSaving(true);

    // The server recomputes the tax, the TDS against the year's running total
    // and the input credit, then posts the entry. The panel above is a preview
    // of that — the browser cannot know what this vendor has already been
    // billed this year, and TDS thresholds are annual.
    const created = await api
      .post<{ id: string; internalNo: string; totalPaise: number; journalEntryId: string | null }>(
        '/api/bills',
        {
          branchId,
          vendorId,
          vendorInvoiceNo,
          date,
          dueDate,
          isRcm,
          costCentreId: costCentreId || undefined,
          warehouseId: warehouseId || undefined,
          ...(foreign ? { currency, exchangeRate: rate } : {}),
          tdsSectionOverride: tdsOverride || undefined,
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
              itcEligibility: itc[l.key] ?? 'eligible',
              batch: l.batchNo ? { batchNo: l.batchNo, expiryDate: l.expiryDate || null } : undefined,
              serials: serialsOf(l),
            })),
        },
      )
      .catch((err: unknown) => {
        setSaving(false);
        if (err instanceof ApiError && err.isQueued) {
          toast.success('Kept on this device', { description: 'It will be sent when you are back online.' });
          router.push('/purchases/bills');
          return null;
        }
        toast.error(err instanceof ApiError ? err.message : 'Could not record the bill.', {
          description:
            err instanceof ApiError && err.details
              ? Object.values(err.details).join(' ')
              : 'Nothing was saved.',
        });
        return null;
      });

    if (!created) return;
    await uploadPending('bill', created.id, pendingFiles);

    toast.success(`Bill ${created.internalNo} recorded`, {
      description: 'Posted to the ledger — open the Journal tab to see the entry.',
    });
    toastWarnings(created);
    router.push(`/purchases/bills/${created.id}`);
  };

  return (
    <DocumentForm
      title="New Bill"
      icon={<FileText className="size-5 text-muted-foreground" />}
      backHref="/purchases/bills"
      footer={
        <>
          <Button onClick={save} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save Bill
          </Button>
          <Button variant="ghost" onClick={() => router.push('/purchases/bills')} disabled={saving}>
            Cancel
          </Button>
        </>
      }
      footerSummary={
        <>
          <p className="text-sm">
            <span className="text-muted-foreground">Payable to Vendor: </span>
            <span className="font-semibold tabular">{formatINR(totals.payable)}</span>
          </p>
          <p className="text-[11px] text-muted-foreground">
            Total Quantity: <span className="tabular">{totals.qty}</span>
          </p>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed p-3 text-sm">
          <ScanText className="size-4 text-muted-foreground" />
          <span className="text-muted-foreground">Have the bill as a PDF or a photo? It can be read in and checked here.</span>
          <label className={`ml-auto inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-3 text-xs font-medium hover:bg-muted ${reading ? 'pointer-events-none opacity-60' : ''}`}>
            {reading ? <Loader2 className="size-3.5 animate-spin" /> : <ScanText className="size-3.5" />} {reading ? 'Reading…' : 'Read a bill'}
            <input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" className="sr-only" disabled={reading}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void readBill(f); }} />
          </label>
          {(readNotes.length > 0 || unmatched) && (
            <ul className="w-full list-disc space-y-0.5 pl-6 text-xs text-amber-700 dark:text-amber-300">
              {unmatched && !vendorId && (
                <li>
                  {unmatched.name}{unmatched.gstin ? ` (${unmatched.gstin})` : ''} is not among your suppliers.{' '}
                  <button type="button" className="font-medium underline" onClick={() => setNewVendorName(unmatched.name)}>Add {unmatched.name}</button>
                </li>
              )}
              {readNotes.map((n) => <li key={n}>{n}</li>)}
            </ul>
          )}
        </div>

        <FormRow label="Vendor Name" required width="lg">
          <Combobox
            options={vendors}
            value={vendorId}
            onChange={onVendorChange}
            placeholder="Select or add a vendor"
            searchPlaceholder="Search vendors by name or GSTIN"
            createLabel="New vendor"
            onCreate={(q) => setNewVendorName(q)}
            clearable
          />
          {vendor && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary" className="text-[10px] capitalize">
                {vendor.gstTreatment.replace(/_/g, ' ')}
              </Badge>
              <Badge variant="outline" className="text-[10px]">{stateName(vendor.stateCode)}</Badge>
              {vendor.isMsme && (
                <Badge variant="outline" className="border-amber-500/40 text-[10px]">
                  MSME · pay within 45 days
                </Badge>
              )}
              {!vendor.pan && (
                <Badge variant="outline" className="border-destructive/40 text-[10px]">
                  No PAN → TDS at 20%
                </Badge>
              )}
            </div>
          )}
        </FormRow>

        <FormRowPair>
          <FormRow label="Bill#" required hint="As printed on the vendor's document">
            <Input
              value={vendorInvoiceNo}
              onChange={(e) => setVendorInvoiceNo(e.target.value)}
              placeholder="Their invoice number"
            />
          </FormRow>
          <FormRow label="Order Number">
            <Input
              value={orderNumber}
              onChange={(e) => setOrderNumber(e.target.value)}
              placeholder="Your PO reference"
            />
          </FormRow>
        </FormRowPair>

        <FormRowPair>
          <FormRow label="Bill Date" required>
            <Input
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setDueDate(dueDateFor(paymentTerms, e.target.value));
              }}
            />
          </FormRow>
          <FormRow label="Payment Terms">
            <Combobox
              options={termsOptions()}
              value={paymentTerms}
              onChange={onTermsChange}
              showAvatar={false}
              placeholder="Select terms"
            />
          </FormRow>
        </FormRowPair>

        <FormRowPair>
          <FormRow label="Due Date">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </FormRow>
          {multiBranch ? (
            <FormRow
              label="Branch (GSTIN)"
              required
              hint="Which registration receives this purchase"
            >
              <Combobox
                options={branches}
                value={branchId}
                onChange={setBranchId}
                placeholder="Select branch"
              />
            </FormRow>
          ) : (
            <div />
          )}
        </FormRowPair>

        {(foreign || vendor?.gstTreatment === 'overseas') && (
          <FormRow label="Currency" hint="The supplier's currency; the bill is booked in rupees at the rate">
            <div className="flex gap-2">
              <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'INR')} className="w-24 font-mono" maxLength={3} />
              {foreign && <Input type="number" step="0.0001" min={0} placeholder={`₹ for 1 ${currency}`} value={fxRate} onChange={(e) => setFxRate(e.target.value)} className="w-40" />}
            </div>
          </FormRow>
        )}

        <CostCentrePicker as="row" value={costCentreId} onChange={setCostCentreId} />
        <GodownPicker as="row" branchId={branchId} value={warehouseId} onChange={setWarehouseId} />

        <FormRow label="Subject" width="lg">
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="What this bill is for"
          />
        </FormRow>

        <FormRow label="Reference No." width="lg" hint="Our internal bill number in the series">
          <Input value={internalNo} readOnly className="bg-muted/40 font-mono" />
        </FormRow>
      </div>

      {isUnregistered && (
        <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">This vendor isn&apos;t GST-registered</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              For certain supplies from unregistered persons, <em>you</em> pay the GST directly to the government
              instead of the supplier. This is <strong>reverse charge</strong>: you raise a self-invoice, record the
              tax as payable, and claim the same amount back as credit — so it nets to zero, but it must be reported.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Switch checked={isRcm} onCheckedChange={setIsRcm} />
              <span className="text-xs font-medium">Apply reverse charge</span>
            </div>
          </div>
        </div>
      )}

      <FormSectionRule label="Item Table" />

      <LineItemsEditor
        docDate={date}
        lines={lines}
        onChange={setLines}
        supplyType={supplyType}
        priceMode="purchase"
        batchMode="enter"
        showItcColumn={!isComposition}
        itcValues={itc}
        onItcChange={(k, v) => setItc((m) => ({ ...m, [k]: v }))}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-[13px] text-field-label">Notes</label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Internal notes — not shown to the vendor"
            />
          </div>
          <PendingAttachments value={pendingFiles} onChange={setPendingFiles} label="Attach File(s) to Bill" />
        </div>

        <div className="rounded-md border bg-muted/30 p-4">
          <dl className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Taxable Value</dt>
              <dd className="tabular">{formatINR(totals.tax.taxablePaise)}</dd>
            </div>
            {totals.tax.cgstPaise > 0 && (
              <>
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">CGST (input credit)</dt>
                  <dd className="tabular">{formatINR(totals.tax.cgstPaise)}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">SGST (input credit)</dt>
                  <dd className="tabular">{formatINR(totals.tax.sgstPaise)}</dd>
                </div>
              </>
            )}
            {totals.tax.igstPaise > 0 && (
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">IGST (input credit)</dt>
                <dd className="tabular">{formatINR(totals.tax.igstPaise)}</dd>
              </div>
            )}
            <div className="flex items-center justify-between border-t pt-2">
              <dt className="text-muted-foreground">Bill Value</dt>
              <dd className="tabular">{formatINR(totals.gross)}</dd>
            </div>

            <div className="space-y-1.5 border-t pt-2">
              <label className="block text-xs text-muted-foreground">
                TDS Section
                {vendor?.tdsSection && (
                  <span className="ml-1 text-[11px]">(vendor default: {vendor.tdsSection})</span>
                )}
              </label>
              <Combobox
                options={TDS_SECTIONS.map((t) => ({
                  value: t.code,
                  label: `${t.code} — ${t.description}`,
                  sublabel: `${t.ratePctWithPan}% with PAN`,
                }))}
                value={tdsOverride}
                onChange={setTdsOverride}
                placeholder={vendor?.tdsSection ?? 'No TDS'}
                showAvatar={false}
                clearable
                className="h-8"
              />
              {totals.tds.applies ? (
                <div className="rounded border border-amber-500/40 bg-amber-500/5 p-2.5">
                  <p className="text-xs font-medium">TDS withheld: {formatINR(totals.tds.tdsPaise)}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {totals.tds.reason}. You pay the vendor less and send this to the government on their behalf.
                  </p>
                </div>
              ) : (vendor?.tdsSection || tdsOverride) ? (
                <p className="text-[11px] leading-relaxed text-muted-foreground">{totals.tds.reason}</p>
              ) : null}
            </div>

            <div className="flex items-center justify-between border-t pt-2.5 text-base font-semibold">
              <dt>Payable to Vendor</dt>
              <dd className="tabular">{foreign ? new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(totals.payable / 100) : formatINR(totals.payable)}</dd>
            </div>
          </dl>

          {isComposition && (
            <p className="mt-3 border-t pt-3 text-[11px] leading-relaxed text-muted-foreground">
              Composition dealers pay a flat rate on turnover and cannot collect GST, so there&apos;s no input
              credit to claim here — the whole amount becomes your cost.
            </p>
          )}
        </div>
      </div>

      {/* onVendorChange rather than a bare setState: a new vendor's payment
          terms set the due date, and an unregistered one puts the bill on
          reverse charge — both of which the document has to know now. */}
      <QuickContactDialog
        kind="vendor"
        open={newVendorName !== null}
        onOpenChange={(o) => !o && setNewVendorName(null)}
        initialName={newVendorName ?? ''}
        onCreated={onVendorChange}
      />
    </DocumentForm>
  );
}
