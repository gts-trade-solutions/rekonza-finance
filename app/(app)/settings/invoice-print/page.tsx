'use client';

// ─────────────────────────────────────────────────────────────────────────────
// What an invoice carries besides what the law requires.
//
// Rule 46 decides the rest of the page. This is the part that gets an invoice
// paid: the logo a customer recognises, the account to pay into, a UPI code
// for the balance due, the standard terms and the signatory's name.
// ─────────────────────────────────────────────────────────────────────────────

import { PRINT_LANGUAGES } from '@/lib/print-languages';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ImageUp, Loader2, Save, Trash2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import { files, invoicePrint, type InvoicePrintSettings } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { isValidVpa, upiPayUri } from '@/lib/billing/upi';

const NONE = 'none';

interface Form {
  bankAccountId: string;
  accountNumber: string;
  accountHolder: string;
  ifsc: string;
  branchName: string;
  upiId: string;
  upiPayeeName: string;
  showUpiQr: boolean;
  defaultTerms: string;
  defaultNotes: string;
  signatoryName: string;
  printLanguage: string;
}

function toForm(d: InvoicePrintSettings): Form {
  const acct = d.bankAccounts.find((a) => a.id === d.bankAccountId);
  return {
    bankAccountId: d.bankAccountId ?? NONE,
    accountNumber: acct?.accountNumber ?? '',
    accountHolder: acct?.accountHolder ?? '',
    ifsc: acct?.ifsc ?? '',
    branchName: acct?.branchName ?? '',
    upiId: d.upiId ?? '',
    upiPayeeName: d.upiPayeeName ?? '',
    showUpiQr: d.showUpiQr,
    defaultTerms: d.defaultTerms ?? '',
    defaultNotes: d.defaultNotes ?? '',
    signatoryName: d.signatoryName ?? '',
    printLanguage: d.printLanguage ?? '',
  };
}

export default function InvoicePrintPage() {
  const state = useApi(() => invoicePrint.get(), []);
  return (
    <>
      <PageHeader
        title="Invoice print"
        description="The logo, bank details, UPI code and standard terms printed on every invoice."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/settings"><ArrowLeft className="mr-1.5 size-3.5" /> Settings</Link>
          </Button>
        }
      />
      <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
        {(d) => <PrintForm data={d} onSaved={() => void state.refetch()} />}
      </AsyncPage>
    </>
  );
}

function PrintForm({ data, onSaved }: { data: InvoicePrintSettings; onSaved: () => void }) {
  const canEdit = usePermission('settings', 'edit');
  const [f, setF] = useState<Form>(() => toForm(data));
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const logoInput = useRef<HTMLInputElement>(null);
  useEffect(() => setF(toForm(data)), [data]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const pickAccount = (id: string) => {
    const a = data.bankAccounts.find((x) => x.id === id);
    setF((x) => ({
      ...x, bankAccountId: id,
      accountNumber: a?.accountNumber ?? '', accountHolder: a?.accountHolder ?? '',
      ifsc: a?.ifsc ?? '', branchName: a?.branchName ?? '',
    }));
  };
  const chosen = data.bankAccounts.find((a) => a.id === f.bankAccountId);
  const upiOk = f.upiId.trim() === '' || isValidVpa(f.upiId);

  const save = async () => {
    setSaving(true);
    try {
      const withBank = f.bankAccountId !== NONE;
      await invoicePrint.save({
        bankAccountId: withBank ? f.bankAccountId : null,
        bank: withBank && f.accountNumber.trim()
          ? {
              accountNumber: f.accountNumber.replace(/\s+/g, ''), accountHolder: f.accountHolder || null,
              ifsc: f.ifsc, branchName: f.branchName || null,
            }
          : null,
        upiId: f.upiId.trim() || null,
        upiPayeeName: f.upiPayeeName.trim() || null,
        showUpiQr: f.showUpiQr,
        defaultTerms: f.defaultTerms.trim() || null,
        defaultNotes: f.defaultNotes.trim() || null,
        signatoryName: f.signatoryName.trim() || null,
        printLanguage: f.printLanguage || null,
      });
      toast.success('Saved. Invoices print with these from now on, reprints included.');
      onSaved();
    } catch (e) {
      toast.error('Could not save', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  const uploadLogo = async (picked: FileList | null) => {
    const file = picked?.[0];
    if (!file) return;
    setUploading(true);
    try {
      await files.upload('organization', data.orgId, file);
      toast.success('Logo updated');
      onSaved();
    } catch (e) {
      toast.error('Could not use that file', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setUploading(false);
      if (logoInput.current) logoInput.current.value = '';
    }
  };
  const removeLogo = async () => {
    if (!data.logoFileId) return;
    await files.remove(data.logoFileId);
    toast.success('Logo removed');
    onSaved();
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
      <div className="space-y-4">
        <Card className="space-y-4 p-5">
          <h3 className="text-sm font-semibold">Logo</h3>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex h-20 w-48 items-center justify-center rounded-md border bg-white p-2">
              {data.logoFileId
                // eslint-disable-next-line @next/next/no-img-element -- an uploaded file served by the API
                ? <img src={files.url(data.logoFileId)} alt="Company logo" className="max-h-full max-w-full object-contain" />
                : <span className="text-xs text-muted-foreground">No logo</span>}
            </div>
            {canEdit && (
              <div className="flex gap-2">
                <input ref={logoInput} type="file" accept=".png,.jpg,.jpeg,.webp" className="hidden"
                  onChange={(e) => void uploadLogo(e.target.files)} />
                <Button size="sm" variant="outline" className="gap-1.5" disabled={uploading} onClick={() => logoInput.current?.click()}>
                  {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <ImageUp className="size-3.5" />}
                  {data.logoFileId ? 'Replace' : 'Upload'}
                </Button>
                {data.logoFileId && (
                  <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => void removeLogo()}>
                    <Trash2 className="size-3.5" /> Remove
                  </Button>
                )}
              </div>
            )}
          </div>
          <p className="text-xs text-muted-foreground">PNG, JPEG or WebP, up to 10 MB. A wide logo on a white background prints best.</p>
        </Card>

        <Card className="space-y-4 p-5">
          <h3 className="text-sm font-semibold">Bank details</h3>
          <Field label="Account to print">
            <Select value={f.bankAccountId} onValueChange={pickAccount} disabled={!canEdit}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Do not print bank details</SelectItem>
                {data.bankAccounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}{a.last4 ? ` ····${a.last4}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {f.bankAccountId !== NONE && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Full account number" required
                hint={chosen?.last4 ? `Must end ${chosen.last4}, as recorded for this account.` : undefined}>
                <Input value={f.accountNumber} onChange={(e) => set('accountNumber', e.target.value)} disabled={!canEdit} inputMode="numeric" />
              </Field>
              <Field label="IFSC" required>
                <Input value={f.ifsc} onChange={(e) => set('ifsc', e.target.value.toUpperCase())} disabled={!canEdit} />
              </Field>
              <Field label="Account holder" hint={`Blank prints ${data.orgName}.`}>
                <Input value={f.accountHolder} onChange={(e) => set('accountHolder', e.target.value)} disabled={!canEdit} />
              </Field>
              <Field label="Bank branch">
                <Input value={f.branchName} onChange={(e) => set('branchName', e.target.value)} disabled={!canEdit} />
              </Field>
            </div>
          )}
        </Card>

        <Card className="space-y-4 p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">UPI</h3>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={f.showUpiQr} onCheckedChange={(v) => set('showUpiQr', v)} disabled={!canEdit} />
              Print a pay-by-UPI code
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="UPI ID" error={upiOk ? undefined : 'A UPI ID looks like name@bank.'}>
              <Input value={f.upiId} placeholder="business@okhdfcbank" onChange={(e) => set('upiId', e.target.value)} disabled={!canEdit} />
            </Field>
            <Field label="Payee name" hint={`Blank uses ${data.orgName}.`}>
              <Input value={f.upiPayeeName} onChange={(e) => set('upiPayeeName', e.target.value)} disabled={!canEdit} />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">
            The code is for the balance due, with the invoice number as its note, so the payer cannot pay a
            wrong amount and the receipt can be matched to the invoice. It is left off paid and cancelled
            invoices and exports.
          </p>
        </Card>

        <Card className="space-y-4 p-5">
          <h3 className="text-sm font-semibold">Standard wording</h3>
          <Field label="Terms" hint="Filled in on each new invoice, where it can still be changed.">
            <Textarea rows={4} value={f.defaultTerms} onChange={(e) => set('defaultTerms', e.target.value)} disabled={!canEdit} />
          </Field>
          <Field label="Notes">
            <Textarea rows={2} value={f.defaultNotes} onChange={(e) => set('defaultNotes', e.target.value)} disabled={!canEdit} />
          </Field>
          <Field label="Authorised signatory" hint="Printed under the signature line.">
            <Input value={f.signatoryName} onChange={(e) => set('signatoryName', e.target.value)} disabled={!canEdit} />
          </Field>
          <Field label="Second language" hint="Labels print in it under the English, which stays the controlling text. It can also be picked when printing, for one customer.">
            <div>
              <select value={f.printLanguage} onChange={(e) => set('printLanguage', e.target.value)} disabled={!canEdit}
                className="h-9 w-full max-w-xs rounded-md border border-input bg-background px-2 text-sm">
                <option value="">English only</option>
                {Object.entries(PRINT_LANGUAGES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
          </Field>
        </Card>

        {canEdit && (
          <div className="flex justify-end">
            <Button onClick={() => void save()} disabled={saving || !upiOk} className="gap-1.5">
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save
            </Button>
          </div>
        )}
      </div>

      <Card className="h-fit space-y-3 p-5 text-center">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">How the UPI code prints</p>
        {f.upiId && upiOk && f.showUpiQr ? (
          <>
            <div className="mx-auto w-fit rounded-md bg-white p-3">
              <QRCodeSVG
                value={upiPayUri({ vpa: f.upiId, payeeName: f.upiPayeeName || data.orgName, amountPaise: 1_180_00, note: 'Invoice INV/26-27/0001' })}
                size={140} level="M" marginSize={0}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Scanning it opens a payment of ₹1,180.00 to {f.upiPayeeName || data.orgName}. Try it with your own UPI app; cancel before paying.
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">Add a UPI ID to see the code.</p>
        )}
      </Card>
    </div>
  );
}
