'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Info, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { toastWarnings } from '@/lib/api/warnings';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import { ContactPicker } from '@/components/forms/quick-create';
import { PageHeader } from '@/components/shared/page-header';
import { Field, FormSection, MoneyInput, TotalRow } from '@/components/shared/form-bits';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { useAppStore } from '@/lib/store';
import { customers, today } from '@/lib/selectors';
import { api, ApiError, invoices as invoiceApi, openingBalances, type InvoiceListResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useSession } from '@/components/layout/session-provider';
import type { PaymentMode } from '@/lib/types';

const MODES: PaymentMode[] = ['neft', 'upi', 'imps', 'cheque', 'cash', 'card', 'gateway'];

function NewPaymentInner() {
  const router = useRouter();
  const params = useSearchParams();
  const s = useAppStore();
  const custList = customers(s);

  const [customerId, setCustomerId] = useState(params.get('customer') ?? '');
  const [date, setDate] = useState(today());
  const [mode, setMode] = useState<PaymentMode>('neft');
  const [bankAccountId, setBankAccountId] = useState('');
  const [reference, setReference] = useState('');
  const [tdsPaise, setTdsPaise] = useState(0);
  const [chargesPaise, setChargesPaise] = useState(0);
  const [selected, setSelected] = useState<Record<string, number>>({});
  // Money received beyond what is applied stays on account as an advance.
  const [advancePaise, setAdvancePaise] = useState(0);
  const [advanceForServices, setAdvanceForServices] = useState(false);
  const [advanceRate, setAdvanceRate] = useState(18);
  const [saving, setSaving] = useState(false);
  const session = useSession();

  // Bank accounts come from the server, because the payment posts against the
  // ledger account behind whichever one is picked.
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

  // Only this customer's unsettled invoices, oldest first — which is the order
  // anybody applying a receipt works in.
  const openState = useApi<InvoiceListResponse>(
    () =>
      customerId
        ? invoiceApi.list({ customerId, open: true, limit: 200 })
        : Promise.resolve({ invoices: [], statusCounts: {}, summary: { count: 0, totalPaise: 0, duePaise: 0 } }),
    [customerId],
  );
  // Bills from before the books started, carried in as openings, are paid off
  // the same way. Their keys say so, so the receipt can tell them apart.
  const openingState = useApi(
    () => customerId
      ? openingBalances.documents({ contactId: customerId, kind: 'receivable', open: true })
      : Promise.resolve({ documents: [] }),
    [customerId],
  );
  const openInvs = useMemo(
    () => [
      ...(openingState.data?.documents ?? []).map((o) => ({
        id: `opening:${o.id}`, number: `Opening ${o.refNo}`, dueDate: o.dueDate, status: 'open', balancePaise: o.balancePaise,
      })),
      ...(openState.data?.invoices ?? []).map((i) => ({
        id: i.id, number: i.number, dueDate: i.dueDate, status: i.status,
        balancePaise: i.fcBalancePaise ?? i.balancePaise, currency: i.currency ?? 'INR',
      })),
    ].sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    [openState.data, openingState.data],
  );

  // Arriving from an invoice's "record payment" action: preselect it in full.
  const preselected = useRef(false);
  useEffect(() => {
    const invId = params.get('invoice');
    if (!invId || preselected.current) return;
    const inv = openInvs.find((i) => i.id === invId);
    if (!inv) return;
    setSelected({ [inv.id]: inv.balancePaise });
    preselected.current = true;
  }, [params, openInvs]);

  const customer = custList.find((c) => c.id === customerId);
  // A customer invoiced in another currency pays in it: amounts below are in
  // that currency, and the rupees the bank credited are entered separately.
  const fxCurrency = customer?.currency && customer.currency !== 'INR' ? customer.currency : null;
  const [rupeesCredited, setRupeesCredited] = useState(0);

  const allocated = Object.values(selected).reduce((t, v) => t + v, 0);
  const cashReceived = fxCurrency ? rupeesCredited + chargesPaise : allocated + advancePaise - tdsPaise - chargesPaise;
  const foreignTotal = allocated + advancePaise;
  const impliedRate = fxCurrency && foreignTotal > 0 ? cashReceived / foreignTotal : 0;
  // GST is inside an advance for services, and due on it now.
  const advanceTax = advanceForServices && advancePaise > 0
    ? Math.round((advancePaise * advanceRate) / (100 + advanceRate))
    : 0;

  const toggle = (invId: string, balance: number) => {
    setSelected((sel) => {
      const next = { ...sel };
      if (next[invId] != null) delete next[invId];
      else next[invId] = balance;
      return next;
    });
  };

  const save = async () => {
    if (!customerId || allocated + advancePaise <= 0) {
      toast.error('Pick a customer, then apply the money to invoices or enter it as an advance.');
      return;
    }
    if (cashReceived <= 0) {
      toast.error('TDS and bank charges come to more than the money received.');
      return;
    }
    if (!bankAccountId) {
      toast.error('Choose which account the money landed in.');
      return;
    }

    setSaving(true);
    const created = await api
      .post<{ id: string; number: string; unappliedPaise: number }>('/api/payments', {
        kind: 'received',
        branchId: session.user.branchId ?? session.branches[0]?.id,
        contactId: customerId,
        date,
        mode,
        bankAccountId,
        // The cash figure only. TDS the customer withheld never reaches the
        // bank, but it still settles the invoice, so it travels separately.
        amountPaise: cashReceived,
        tdsPaise,
        bankChargesPaise: chargesPaise,
        reference: reference || undefined,
        allocations: Object.entries(selected).map(([key, amountPaise]) => ({
          targetType: key.startsWith('opening:') ? ('opening' as const) : ('invoice' as const),
          targetId: key.replace(/^opening:/, ''),
          ...(fxCurrency ? { amountPaise: 0, foreignAmountPaise: amountPaise } : { amountPaise }),
        })),
        fx: fxCurrency ? { currency: fxCurrency, rate: Number(impliedRate.toFixed(6)), foreignAmountPaise: foreignTotal } : undefined,
        advanceGst: advanceForServices && advancePaise > 0 ? { ratePct: advanceRate } : undefined,
      })
      .catch((err: unknown) => {
        setSaving(false);
        if (err instanceof ApiError && err.isQueued) {
          toast.success('Kept on this device', { description: 'It will be sent when you are back online.' });
          router.push('/sales/payments');
          return null;
        }
        toast.error(err instanceof ApiError ? err.message : 'Could not record the payment.', {
          description: 'Nothing was saved.',
        });
        return null;
      });

    if (!created) return;

    toastWarnings(created);
    toast.success(`Receipt ${created.number} recorded`, {
      description:
        created.unappliedPaise > 0
          ? `${(created.unappliedPaise / 100).toFixed(2)} left on account for the next invoice.`
          : 'Invoices updated and a balanced journal entry posted.',
    });
    router.push('/sales/payments');
  };

  return (
    <>
      <PageHeader
        title="Record payment received"
        description="Apply one receipt across several invoices. TDS withheld by the customer is tracked separately."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => router.back()}>Cancel</Button>
            <Button size="sm" onClick={save} disabled={saving} className="gap-1.5">
              <Wallet className="size-3.5" /> Record payment
            </Button>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card className="p-5">
            <FormSection title="Payment details">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Customer" required>
                  <ContactPicker
                    kind="customer"
                    value={customerId}
                    onChange={(v) => { setCustomerId(v); setSelected({}); }}
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
                <Field label="Deposit to">
                  <Combobox
                    // A credit card cannot receive a customer's money.
                    options={bankOptions.filter((o) => o.sublabel !== 'card')}
                    value={bankAccountId}
                    onChange={setBankAccountId}
                    placeholder="Select account"
                    searchPlaceholder="Search accounts"
                  />
                </Field>
                <Field label="Reference" className="sm:col-span-2">
                  <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / cheque no. / UPI ref" />
                </Field>
              </div>
            </FormSection>
          </Card>

          <Card className="p-5">
            <FormSection
              title="Apply to invoices"
              description={customerId ? `${openInvs.length} unpaid invoice(s) for this customer` : 'Select a customer first'}
            >
              {customer?.billWise === false && (
                <p className="mb-3 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                  This customer is not kept bill-wise. Leave the invoices unticked and the receipt settles the oldest first.
                </p>
              )}
              {openInvs.length === 0 ? (
                <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  {customerId ? 'This customer has no outstanding invoices.' : 'No customer selected.'}
                </p>
              ) : (
                <div className="overflow-x-auto rounded-lg border thin-scroll">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="w-10 px-3 py-2" />
                        <th className="px-3 py-2 text-left font-semibold">Invoice</th>
                        <th className="px-3 py-2 text-left font-semibold">Due</th>
                        <th className="px-3 py-2 text-left font-semibold">Status</th>
                        <th className="px-3 py-2 text-right font-semibold">Balance</th>
                        <th className="px-3 py-2 text-right font-semibold">Applying</th>
                      </tr>
                    </thead>
                    <tbody>
                      {openInvs.map((inv) => {
                        const bal = inv.balancePaise;
                        const isSel = selected[inv.id] != null;
                        return (
                          <tr key={inv.id} className="border-b last:border-0">
                            <td className="px-3 py-2">
                              <Checkbox checked={isSel} onCheckedChange={() => toggle(inv.id, bal)} />
                            </td>
                            <td className="px-3 py-2 font-medium">{inv.number}</td>
                            <td className="px-3 py-2 text-xs text-muted-foreground">
                              {new Date(inv.dueDate).toLocaleDateString('en-IN')}
                            </td>
                            <td className="px-3 py-2"><StatusBadge status={inv.status as never} /></td>
                            <td className="px-3 py-2 text-right">{fxCurrency ? fxMoney(bal, fxCurrency) : <Money value={bal} />}</td>
                            <td className="px-3 py-2">
                              {isSel ? (
                                <MoneyInput
                                  valuePaise={selected[inv.id]}
                                  onChangePaise={(p) =>
                                    setSelected((sel) => ({ ...sel, [inv.id]: Math.min(p, bal) }))
                                  }
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
            </FormSection>
          </Card>
        </div>

        <div>
          <Card className="sticky top-20 space-y-4 p-5">
            <h3 className="text-sm font-semibold">Summary</h3>

            <TotalRow label="Applied to invoices">{fxCurrency ? fxMoney(allocated, fxCurrency) : <Money value={allocated} />}</TotalRow>

            <div className="space-y-3 border-t pt-3">
              <Field
                label="Advance, kept on account"
                hint="Money received ahead of an invoice. Apply it later from Payments received."
              >
                <MoneyInput valuePaise={advancePaise} onChangePaise={setAdvancePaise} />
              </Field>
              {advancePaise > 0 && (
                <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox
                      checked={advanceForServices}
                      onCheckedChange={(v) => setAdvanceForServices(v === true)}
                      className="mt-0.5"
                    />
                    <span>It is for services, so GST is due on it now</span>
                  </label>
                  {advanceForServices && (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">GST rate</span>
                        <select
                          className="h-8 rounded-md border bg-background px-2 text-sm"
                          value={advanceRate}
                          onChange={(e) => setAdvanceRate(Number(e.target.value))}
                        >
                          {[5, 12, 18, 28, 40].map((r) => <option key={r} value={r}>{r}%</option>)}
                        </select>
                      </div>
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        <Money value={advanceTax} /> of the advance is GST, paid with this month&apos;s return and taken back
                        when the advance is applied to the invoice. Advances for goods carry no GST.
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>

            {fxCurrency && (
              <div className="space-y-2 border-t pt-3">
                <Field label="Rupees credited by the bank" hint={`For ${fxMoney(foreignTotal, fxCurrency)} received, after the bank's charges`}>
                  <MoneyInput valuePaise={rupeesCredited} onChangePaise={setRupeesCredited} />
                </Field>
                {impliedRate > 0 && (
                  <p className="text-xs text-muted-foreground">
                    ₹{impliedRate.toFixed(4)} per {fxCurrency}. The difference from the rate each invoice was booked at is
                    posted as an exchange gain or loss.
                  </p>
                )}
              </div>
            )}

            <div className="space-y-3 border-t pt-3">
              {!fxCurrency && <Field
                label="TDS deducted by customer"
                hint={customer?.customerDeductsTds ? 'This customer usually withholds TDS' : 'Leave zero if none'}
              >
                <MoneyInput valuePaise={tdsPaise} onChangePaise={setTdsPaise} />
              </Field>}
              <Field label="Bank charges" hint={fxCurrency ? 'In rupees' : undefined}>
                <MoneyInput valuePaise={chargesPaise} onChangePaise={setChargesPaise} />
              </Field>
            </div>

            <div className="border-t pt-3">
              <TotalRow label="Cash actually received" emphasis>
                <Money value={cashReceived} />
              </TotalRow>
            </div>

            {tdsPaise > 0 && (
              <div className="rounded-md border bg-muted/40 p-3">
                <div className="flex items-start gap-2">
                  <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    The customer keeps <Money value={tdsPaise} /> and pays it to the government on your behalf.
                    We record it as <span className="font-medium text-foreground">TDS Receivable</span> — an asset you
                    reclaim when filing your income tax return. The invoice is still settled in full.
                  </p>
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
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
