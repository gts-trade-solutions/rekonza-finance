'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Banknote } from 'lucide-react';
import { toast } from 'sonner';
import { toastWarnings } from '@/lib/api/warnings';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import { ContactPicker } from '@/components/forms/quick-create';
import { PageHeader } from '@/components/shared/page-header';
import { Field, FormSection, MoneyInput, TotalRow } from '@/components/shared/form-bits';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { useAppStore } from '@/lib/store';
import { today, vendors } from '@/lib/selectors';
import { api, ApiError, bills as billApi, type BillListResponse, openingBalances } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useSession } from '@/components/layout/session-provider';
import type { PaymentMode } from '@/lib/types';

const MODES: PaymentMode[] = ['neft', 'imps', 'upi', 'cheque', 'cash', 'card'];

function PayInner() {
  const router = useRouter();
  const params = useSearchParams();
  const s = useAppStore();
  const vendorList = vendors(s);

  const [vendorId, setVendorId] = useState('');
  const [date, setDate] = useState(today());
  const [mode, setMode] = useState<PaymentMode>('neft');
  const [bankAccountId, setBankAccountId] = useState('');
  const [reference, setReference] = useState('');
  const [selected, setSelected] = useState<Record<string, number>>({});
  // Paid ahead of the bill; it stays on account until a bill is set against it.
  const [advancePaise, setAdvancePaise] = useState(0);
  const [saving, setSaving] = useState(false);
  const session = useSession();

  // Bank accounts come from the server: the payment posts against the ledger
  // account behind whichever one is chosen.
  const mastersState = useApi<{ bankAccounts: { id: string; name: string; kind: string }[] }>(
    () => api.get('/api/masters'),
    [],
  );
  const bankOptions = useMemo(
    () => (mastersState.data?.bankAccounts ?? []).map((b) => ({ value: b.id, label: b.name, sublabel: b.kind })),
    [mastersState.data],
  );
  useEffect(() => {
    if (!bankAccountId && bankOptions.length) setBankAccountId(bankOptions[0].value);
  }, [bankAccountId, bankOptions]);

  // This vendor's unpaid bills, oldest due first — the order a payment run
  // works in, and the order that keeps MSME suppliers inside their 45 days.
  const openState = useApi<BillListResponse>(
    () =>
      vendorId
        ? billApi.list({ vendorId, open: true, limit: 200 })
        : Promise.resolve({ bills: [], summary: { count: 0, totalPaise: 0, duePaise: 0 } }),
    [vendorId],
  );
  // Bills from before the books started, carried in as openings.
  const openingState = useApi(
    () => vendorId
      ? openingBalances.documents({ contactId: vendorId, kind: 'payable', open: true })
      : Promise.resolve({ documents: [] }),
    [vendorId],
  );
  const openBills = useMemo(
    () => [
      ...(openingState.data?.documents ?? []).map((o) => ({
        id: `opening:${o.id}`, vendorId: o.contactId, internalNo: `Opening ${o.refNo}`, vendorInvoiceNo: o.refNo,
        date: o.docDate, dueDate: o.dueDate, status: 'open', isMsme: false, balancePaise: o.balancePaise, isOpening: true,
      })),
      ...(openState.data?.bills ?? []).map((b) => ({ ...b, balancePaise: b.fcBalancePaise ?? b.balancePaise, isOpening: false })),
    ].sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    [openState.data, openingState.data],
  );

  // Arriving from a bill's "pay" action: preselect it in full.
  const preselected = useRef(false);
  useEffect(() => {
    const billId = params.get('bill');
    if (!billId || preselected.current) return;
    const b = openBills.find((x) => x.id === billId);
    if (!b) return;
    setVendorId(b.vendorId);
    setSelected({ [b.id]: b.balancePaise });
    preselected.current = true;
  }, [params, openBills]);

  const vendor = vendorList.find((v) => v.id === vendorId);
  const applied = Object.values(selected).reduce((t, v) => t + v, 0);
  const total = applied + advancePaise;
  // A supplier billing in another currency is paid in it: the amounts are in
  // that currency, and the rupees that left the bank are entered separately.
  const fxCurrency = vendor?.currency && vendor.currency !== 'INR' ? vendor.currency : null;
  const [rupeesPaid, setRupeesPaid] = useState(0);
  const fxMoney = (minor: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: fxCurrency ?? 'INR' }).format(minor / 100);

  const toggle = (id: string, bal: number) =>
    setSelected((sel) => {
      const next = { ...sel };
      if (next[id] != null) delete next[id];
      else next[id] = bal;
      return next;
    });

  const selectAll = () => {
    const all: Record<string, number> = {};
    openBills.forEach((b) => { all[b.id] = b.balancePaise; });
    setSelected(all);
  };

  const save = async () => {
    if (!vendorId || total <= 0) {
      toast.error('Pick a vendor, then choose bills to pay or enter an advance.');
      return;
    }
    if (!bankAccountId) {
      toast.error('Choose which account this is paid from.');
      return;
    }
    if (fxCurrency && rupeesPaid <= 0) {
      toast.error('Enter the rupees the bank debited for it.');
      return;
    }

    setSaving(true);
    const created = await api
      .post<{ id: string; number: string; unappliedPaise: number }>('/api/payments', {
        kind: 'made',
        branchId: session.user.branchId ?? session.branches[0]?.id,
        contactId: vendorId,
        date,
        mode,
        bankAccountId,
        amountPaise: fxCurrency ? rupeesPaid : total,
        reference: reference || undefined,
        allocations: Object.entries(selected).map(([key, amountPaise]) => ({
          targetType: key.startsWith('opening:') ? ('opening' as const) : ('bill' as const),
          targetId: key.replace(/^opening:/, ''),
          ...(fxCurrency ? { amountPaise: 0, foreignAmountPaise: amountPaise } : { amountPaise }),
        })),
        fx: fxCurrency ? { currency: fxCurrency, rate: Number((rupeesPaid / total).toFixed(6)), foreignAmountPaise: total } : undefined,
      })
      .catch((err: unknown) => {
        setSaving(false);
        if (err instanceof ApiError && err.isQueued) {
          toast.success('Kept on this device', { description: 'It will be sent when you are back online.' });
          router.push('/purchases/payments');
          return null;
        }
        toast.error(err instanceof ApiError ? err.message : 'Could not record the payment.', {
          description: 'Nothing was saved.',
        });
        return null;
      });

    if (!created) return;

    toastWarnings(created);
    toast.success(`Payment ${created.number} recorded`, {
      description: created.unappliedPaise > 0
        ? `${(created.unappliedPaise / 100).toFixed(2)} kept on account as an advance to the vendor.`
        : `${Object.keys(selected).length} bill(s) settled and a balanced entry posted.`,
    });
    router.push('/purchases/payments');
  };

  return (
    <>
      <PageHeader
        title="Pay vendor"
        description="Settle several bills in one payment run. Oldest due dates first."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => router.back()}>Cancel</Button>
            <Button size="sm" onClick={save} disabled={saving} className="gap-1.5">
              <Banknote className="size-3.5" /> {saving ? 'Recording…' : 'Record payment'}
            </Button>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card className="p-5">
            <FormSection title="Payment details">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Vendor" required>
                  <ContactPicker
                    kind="vendor"
                    value={vendorId}
                    onChange={(v) => { setVendorId(v); setSelected({}); }}
                  />
                </Field>
                <Field label="Payment date" required>
                  <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </Field>
                <Field label="Mode">
                  <Combobox
                    options={MODES.map((m) => ({ value: m, label: m.toUpperCase() }))}
                    value={mode}
                    onChange={(v) => setMode(v as PaymentMode)}
                    showAvatar={false}
                    searchPlaceholder="Search modes"
                  />
                </Field>
                <Field label="Pay from">
                  <Combobox
                    options={bankOptions}
                    value={bankAccountId}
                    onChange={setBankAccountId}
                    placeholder="Select account"
                    searchPlaceholder="Search accounts"
                  />
                </Field>
                <Field label="Reference" className="sm:col-span-2">
                  <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / cheque no." />
                </Field>
              </div>
            </FormSection>
          </Card>

          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold">Bills to pay</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {vendorId ? `${openBills.length} unpaid bill(s)` : 'Select a vendor first'}
                </p>
              </div>
              {openBills.length > 0 && (
                <Button variant="outline" size="sm" onClick={selectAll}>Select all</Button>
              )}
            </div>
            {vendor?.billWise === false && (
              <p className="mb-3 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                This vendor is not kept bill-wise. Leave the bills unticked and the payment settles the oldest first.
              </p>
            )}
            {openBills.length === 0 ? (
              <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                {vendorId ? 'Nothing outstanding for this vendor.' : 'No vendor selected.'}
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border thin-scroll">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="w-10 px-3 py-2" />
                      <th className="px-3 py-2 text-left font-semibold">Bill</th>
                      <th className="px-3 py-2 text-left font-semibold">Due</th>
                      <th className="px-3 py-2 text-left font-semibold">Status</th>
                      <th className="px-3 py-2 text-right font-semibold">Balance</th>
                      <th className="px-3 py-2 text-right font-semibold">Paying</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openBills.map((b) => {
                      const bal = b.balancePaise;
                      const isSel = selected[b.id] != null;
                      const overdue = b.dueDate < today();
                      return (
                        <tr key={b.id} className="border-b last:border-0">
                          <td className="px-3 py-2"><Checkbox checked={isSel} onCheckedChange={() => toggle(b.id, bal)} /></td>
                          <td className="px-3 py-2">
                            <p className="font-medium">{b.internalNo}</p>
                            <p className="text-xs text-muted-foreground">{b.vendorInvoiceNo}</p>
                          </td>
                          <td className={`px-3 py-2 text-xs ${overdue ? 'text-destructive' : 'text-muted-foreground'}`}>
                            {new Date(b.dueDate).toLocaleDateString('en-IN')}
                          </td>
                          <td className="px-3 py-2"><StatusBadge status={(overdue ? 'overdue' : b.status) as never} /></td>
                          <td className="px-3 py-2 text-right"><Money value={bal} /></td>
                          <td className="px-3 py-2">
                            {isSel ? (
                              <MoneyInput
                                valuePaise={selected[b.id]}
                                onChangePaise={(p) => setSelected((sel) => ({ ...sel, [b.id]: Math.min(p, bal) }))}
                                className="h-8 w-32"
                              />
                            ) : (
                              <span className="block text-right text-muted-foreground">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <div>
          <Card className="sticky top-20 space-y-3 p-5">
            <h3 className="text-sm font-semibold">Summary</h3>
            <TotalRow label="Bills selected">{Object.keys(selected).length}</TotalRow>
            <TotalRow label="Applied to bills">{fxCurrency ? fxMoney(applied) : <Money value={applied} />}</TotalRow>
            <Field label="Advance, kept on account" hint="Paid before the bill. Set it against the bill later from Payments made.">
              <MoneyInput valuePaise={advancePaise} onChangePaise={setAdvancePaise} />
            </Field>
            <TotalRow label="Total payment" emphasis>{fxCurrency ? fxMoney(total) : <Money value={total} />}</TotalRow>
            {fxCurrency && (
              <Field label="Rupees debited by the bank" hint={total > 0 && rupeesPaid > 0 ? `₹${(rupeesPaid / total).toFixed(4)} per ${fxCurrency}; the difference from each bill's rate is an exchange gain or loss` : undefined}>
                <MoneyInput valuePaise={rupeesPaid} onChangePaise={setRupeesPaid} />
              </Field>
            )}

            {vendor?.isMsme && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    <span className="font-medium text-foreground">MSME vendor.</span> Paying within 45 days keeps
                    the expense deductible (section 43B(h); section 37(2)(g) of the Income-tax Act, 2025 from April 2026).
                  </p>
                </div>
              </div>
            )}

            {vendor && (
              <div className="rounded-md border p-3 text-xs">
                <p className="text-muted-foreground">Paying</p>
                <p className="mt-0.5 font-medium">{vendor.displayName}</p>
                {vendor.gstin && <p className="mt-1 font-mono text-[10px] text-muted-foreground">{vendor.gstin}</p>}
                {vendor.tdsSection && (
                  <Badge variant="secondary" className="mt-2 text-[10px]">TDS {vendor.tdsSection} already withheld on bills</Badge>
                )}
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

export default function PayVendorPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground">Loading…</div>}>
      <PayInner />
    </Suspense>
  );
}
