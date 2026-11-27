'use client';

// Record bulk payments, as Zoho Books has it (status review 7, item 6): the
// open bills (or invoices) listed, ticked and filled with what is paid on
// each and any TDS, one date, mode and bank for them all; saving records one
// payment per vendor (or receipt per customer) settling the documents ticked.
// The bank account then shows them for reconciliation against its statement.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Loader2, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage } from '@/components/shared/async-state';
import { EmptyState } from '@/components/shared/empty-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { Money } from '@/components/shared/money';
import { ApiError, bills as billsApi, bulkPayments, invoices as invoicesApi } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { usePermission } from '@/lib/store/hooks';
import { formatINR } from '@/lib/money';

interface Doc { id: string; number: string; ref: string | null; party: string; partyId: string; date: string; dueDate: string; balancePaise: number }
const MODES = [['neft', 'NEFT'], ['rtgs', 'RTGS'], ['imps', 'IMPS'], ['upi', 'UPI'], ['cheque', 'Cheque'], ['cash', 'Cash'], ['netbanking', 'Net banking'], ['card', 'Card'], ['other', 'Other']] as const;
const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const dmy = (d: string) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;

export function BulkPayments({ side }: { side: 'received' | 'made' }) {
  const router = useRouter();
  const canCreate = usePermission(side === 'received' ? 'sales' : 'purchases', 'create');
  const banks = useAppStore((s) => s.bankAccounts);
  const state = useApi<Doc[]>(async () => {
    if (side === 'received') {
      const r = await invoicesApi.list({ open: true, limit: 500 });
      return r.invoices.filter((i) => i.balancePaise > 0).map((i) => ({ id: i.id, number: i.number, ref: null, party: i.customerName, partyId: i.customerId, date: i.date, dueDate: i.dueDate, balancePaise: i.balancePaise }));
    }
    const r = await billsApi.list({ open: true, limit: 500 });
    return r.bills.filter((b) => b.balancePaise > 0).map((b) => ({ id: b.id, number: b.internalNo, ref: b.vendorInvoiceNo, party: b.vendorName, partyId: b.vendorId, date: b.date, dueDate: b.dueDate, balancePaise: b.balancePaise }));
  }, [side]);
  const [date, setDate] = useState(today());
  const [mode, setMode] = useState<string>('neft');
  const [bankId, setBankId] = useState('');
  const [reference, setReference] = useState('');
  const [party, setParty] = useState('');
  const [picked, setPicked] = useState<Record<string, { amount: number; tds: number }>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const word = side === 'received' ? { doc: 'Invoice', docs: 'invoices', party: 'Customer', pay: 'Payment received', title: 'Record Bulk Receipts', list: '/sales/payments', paidInto: 'Deposit to' }
    : { doc: 'Bill', docs: 'bills', party: 'Vendor', pay: 'Payment made', title: 'Record Bulk Payments', list: '/purchases/payments', paidInto: 'Paid through' };

  const docs = useMemo(() => (state.data ?? []).filter((d) => !party || d.party === party), [state.data, party]);
  const parties = useMemo(() => [...new Set((state.data ?? []).map((d) => d.party))].sort(), [state.data]);
  const chosen = Object.entries(picked);
  const total = chosen.reduce((t, [, v]) => t + v.amount, 0);
  const totalTds = chosen.reduce((t, [, v]) => t + v.tds, 0);
  const groups = new Set(chosen.map(([id]) => state.data?.find((d) => d.id === id)?.party)).size;
  const bank = bankId || banks.find((b) => b.kind === 'bank')?.id || banks[0]?.id || '';

  const toggle = (d: Doc, on: boolean) => {
    const next = { ...picked };
    if (on) next[d.id] = { amount: d.balancePaise, tds: 0 }; else delete next[d.id];
    setPicked(next);
  };
  const save = async () => {
    setError(null);
    if (!chosen.length) { setError(`Tick at least one ${word.doc.toLowerCase()}.`); return; }
    if (!bank) { setError('Add a bank or cash account under Banking first.'); return; }
    setSaving(true);
    try {
      const r = await bulkPayments.record({
        side, date, mode, bankAccountId: bank, reference: reference.trim() || null,
        rows: chosen.map(([docId, v]) => ({ docId, amountPaise: v.amount, tdsPaise: v.tds })),
      });
      toast.success(`${r.payments.length} ${side === 'received' ? 'receipt' : 'payment'}${r.payments.length === 1 ? '' : 's'} recorded`, {
        description: r.payments.map((p) => `${p.number}: ${p.partyName} ${formatINR(p.amountPaise)} for ${p.documents} ${word.docs}`).join('; '),
        duration: 10_000,
      });
      router.push(word.list);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : `The ${side === 'received' ? 'receipts' : 'payments'} were not recorded.`);
    } finally { setSaving(false); }
  };

  return (
    <>
      <PageHeader title={word.title} description={`Pay many ${word.docs} at once: one ${side === 'received' ? 'receipt per customer' : 'payment per vendor'}, settling the ${word.docs} ticked.`}
        actions={<Link href={word.list} className="text-sm text-link hover:underline">Back to {word.pay}s</Link>} />
      <div className="mb-4 grid gap-3 rounded-[6px] border p-4 sm:grid-cols-5" data-slot="bulk-pay-head">
        <Field label="Payment date" required><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-slot="bulk-pay-date" /></Field>
        <Field label="Mode"><select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={mode} onChange={(e) => setMode(e.target.value)} data-slot="bulk-pay-mode">
          {MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label={word.paidInto} required><select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={bank} onChange={(e) => setBankId(e.target.value)} data-slot="bulk-pay-bank">
          {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
        <Field label="Reference#"><Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Cheque run, UTR" data-slot="bulk-pay-ref" /></Field>
        <Field label={word.party}><select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={party} onChange={(e) => setParty(e.target.value)} data-slot="bulk-pay-party">
          <option value="">All {word.party.toLowerCase()}s</option>{parties.map((p) => <option key={p} value={p}>{p}</option>)}</select></Field>
      </div>
      <AsyncPage state={state}>
        {() => docs.length === 0 ? (
          <EmptyState icon={Wallet} title={`No open ${word.docs}`} description={`Every ${word.doc.toLowerCase()} is paid. Record one, and it shows here to pay.`} />
        ) : (
          <div className="overflow-x-auto rounded-[6px] border">
            <table className="w-full text-[13px]" data-slot="bulk-pay-table">
              <thead className="bg-muted/50 text-[11.5px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="w-8 px-3 py-2"><input type="checkbox" aria-label="Tick all" checked={docs.every((d) => picked[d.id])}
                    onChange={(e) => { const next = { ...picked }; for (const d of docs) { if (e.target.checked) next[d.id] ??= { amount: d.balancePaise, tds: 0 }; else delete next[d.id]; } setPicked(next); }} /></th>
                  <th className="px-3 py-2 text-left font-medium">{word.party}</th>
                  <th className="px-3 py-2 text-left font-medium">{word.doc}#</th>
                  <th className="px-3 py-2 text-left font-medium">Date</th>
                  <th className="px-3 py-2 text-left font-medium">Due</th>
                  <th className="px-3 py-2 text-right font-medium">Amount due</th>
                  <th className="px-3 py-2 text-right font-medium">{side === 'received' ? 'Amount received' : 'Payment'}</th>
                  <th className="px-3 py-2 text-right font-medium">{side === 'received' ? 'TDS withheld' : 'TDS deducted'}</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => {
                  const p = picked[d.id];
                  return (
                    <tr key={d.id} className="border-t" data-slot="bulk-pay-row" data-doc={d.number}>
                      <td className="px-3 py-2"><input type="checkbox" checked={!!p} onChange={(e) => toggle(d, e.target.checked)} aria-label={`Pay ${d.number}`} data-slot="bulk-pay-tick" /></td>
                      <td className="px-3 py-2 font-medium">{d.party}</td>
                      <td className="px-3 py-2">{d.number}{d.ref && <span className="block text-[11.5px] text-muted-foreground">{d.ref}</span>}</td>
                      <td className="px-3 py-2">{dmy(d.date)}</td>
                      <td className="px-3 py-2">{dmy(d.dueDate)}</td>
                      <td className="px-3 py-2 text-right"><Money value={d.balancePaise} /></td>
                      <td className="px-3 py-2 text-right" data-slot="bulk-pay-amount">{p ? <MoneyInput valuePaise={p.amount} onChangePaise={(v) => setPicked({ ...picked, [d.id]: { ...p, amount: v } })} /> : ''}</td>
                      <td className="px-3 py-2 text-right" data-slot="bulk-pay-tds">{p ? <MoneyInput valuePaise={p.tds} onChangePaise={(v) => setPicked({ ...picked, [d.id]: { ...p, tds: v } })} /> : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </AsyncPage>
      {error && <p className="mt-3 rounded-[6px] bg-[#fdecee] px-4 py-2 text-[13px] text-[#c0392b]" data-slot="bulk-pay-error">{error}</p>}
      <div className="sticky bottom-0 mt-4 flex flex-wrap items-center justify-between gap-3 border-t bg-background py-3" data-slot="bulk-pay-footer">
        <p className="text-[13px]">{chosen.length} {word.docs} ticked for {groups} {side === 'received' ? 'customer' : 'vendor'}{groups === 1 ? '' : 's'} · total <b data-slot="bulk-pay-total">{formatINR(total)}</b>{totalTds ? ` + TDS ${formatINR(totalTds)}` : ''}</p>
        <Button onClick={() => void save()} disabled={saving || !canCreate || !chosen.length} data-slot="bulk-pay-save">
          {saving && <Loader2 className="mr-1 size-4 animate-spin" />} Record {groups > 1 ? `${groups} ` : ''}{side === 'received' ? 'receipts' : 'payments'}
        </Button>
      </div>
    </>
  );
}
