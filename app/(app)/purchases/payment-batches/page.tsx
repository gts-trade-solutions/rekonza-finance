'use client';

// Payment batches — the week's supplier payments chosen together, released
// (by a second person where an approval rule asks), sent to the bank as one
// bulk file, and recorded as payments when the bank has made them.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Download, FileSpreadsheet, Landmark, Loader2, Plus, Send, X } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { Money } from '@/components/shared/money';
import { downloadCsv } from '@/components/shared/report-shell';
import { Attachments } from '@/components/shared/attachments';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { downloadWorkbook } from '@/lib/xlsx';
import { cn } from '@/lib/utils';

type Status = 'draft' | 'pending' | 'approved' | 'paid' | 'rejected' | 'cancelled';
interface Transfer {
  vendorId: string; vendorName: string; accountNo: string | null; ifsc: string | null; amountPaise: number; mode: 'RTGS' | 'NEFT';
  paymentNumber: string | null; bills: { billId: string; number: string; vendorInvoiceNo: string; amountPaise: number }[];
}
interface Batch {
  id: string; number: string; status: Status; payDate: string; bankName: string; totalPaise: number; notes: string | null;
  createdBy: string | null; approvedBy: string | null; rejectionReason: string | null; fileDownloadedAt: string | null; transfers: Transfer[];
}
interface PayableBill {
  id: string; number: string; vendorInvoiceNo: string; vendorId: string; vendorName: string; billDate: string; dueDate: string;
  balancePaise: number; isMsme: boolean; hasBankDetails: boolean; inBatch: string | null;
}

const STATUS: Record<Status, { label: string; className: string }> = {
  draft: { label: 'Draft', className: '' },
  pending: { label: 'Awaiting approval', className: 'border-amber-500/40 text-amber-700 dark:text-amber-300' },
  approved: { label: 'Released', className: 'border-primary/40 text-primary' },
  paid: { label: 'Paid', className: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300' },
  rejected: { label: 'Sent back', className: 'border-destructive/40 text-destructive' },
  cancelled: { label: 'Cancelled', className: 'opacity-60' },
};
const dmy = (d: string) => new Date(d).toLocaleDateString('en-IN');
const iso = (d: Date) => d.toISOString().slice(0, 10);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function PaymentBatchesPage() {
  const canCreate = usePermission('purchases', 'create');
  const state = useApi(() => api.get<{ batches: Batch[]; bankAccounts: { id: string; name: string; hasAccountNo: boolean }[] }>('/api/payment-batches'), []);
  const [building, setBuilding] = useState(false);
  const [paying, setPaying] = useState<Batch | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (id: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(id);
    try {
      await fn();
      toast.success(done);
      await state.refetch();
    } catch (e) {
      toast.error('Not done', { description: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const download = async (b: Batch, as: 'csv' | 'xlsx') => {
    setBusy(b.id);
    try {
      const file = await api.post<{ number: string; columns: string[]; rows: string[][]; debitAccountMissing: boolean }>('/api/payment-batches', { action: 'file', id: b.id });
      const name = `${file.number.replace(/\//g, '-')}-bank-file`;
      if (as === 'csv') downloadCsv(`${name}.csv`, [file.columns, ...file.rows]);
      // Account numbers stay text, so a long one keeps its last digits.
      else downloadWorkbook(name, [{ name: 'Transfers', rows: [file.columns, ...file.rows.map((r) => r.map((c, i) => (i === 4 ? Number(c) : c)))] }]);
      if (file.debitAccountMissing) toast.warning('The paying account has no account number', { description: 'Add it under Banking so the file carries the debit account.' });
      await state.refetch();
    } catch (e) {
      toast.error('No file', { description: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Payment batches"
        description="Choose the bills to pay, release them, upload one bulk file to the bank, then mark the batch paid. Transfers of ₹2 lakh and above go by RTGS."
        actions={canCreate && !building && (
          <Button size="sm" className="gap-1.5" onClick={() => setBuilding(true)}><Plus className="size-4" /> New batch</Button>
        )}
      />

      <AsyncPage state={state} loading={<LoadingRows rows={4} />}>
        {(d) => (
          <div className="space-y-4">
            {building && (
              <Builder banks={d.bankAccounts} onClose={() => setBuilding(false)}
                onCreated={() => { setBuilding(false); void state.refetch(); }} />
            )}
            {d.batches.length === 0 && !building && (
              <EmptyState icon={Landmark} title="No payment batches yet"
                description="A batch gathers the bills to pay this week into one bank upload, instead of a transfer typed per supplier." />
            )}
            {d.batches.map((b) => (
              <Card key={b.id} className={cn('space-y-3 p-4', b.status === 'cancelled' && 'opacity-60')}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-mono font-medium">{b.number}</span>
                  <Badge variant="outline" className={cn('text-[10px]', STATUS[b.status].className)}>{STATUS[b.status].label}</Badge>
                  <span className="text-xs text-muted-foreground">
                    Paying {dmy(b.payDate)} from {b.bankName} · made by {b.createdBy ?? 'unknown'}
                    {b.approvedBy && b.status !== 'draft' ? ` · released by ${b.approvedBy}` : ''}
                  </span>
                  <Money value={b.totalPaise} className="ml-auto text-base font-semibold" />
                </div>
                {b.status === 'rejected' && b.rejectionReason && <p className="text-xs text-destructive">Sent back: {b.rejectionReason}</p>}
                {b.notes && <p className="text-xs text-muted-foreground">{b.notes}</p>}

                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-1.5 font-semibold">Supplier</th>
                        <th className="px-3 py-1.5 font-semibold">Account · IFSC</th>
                        <th className="px-3 py-1.5 font-semibold">Bills</th>
                        <th className="px-3 py-1.5 font-semibold">Mode</th>
                        <th className="px-3 py-1.5 text-right font-semibold">Amount</th>
                        {b.status === 'paid' && <th className="px-3 py-1.5 font-semibold">Payment</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {b.transfers.map((t) => (
                        <tr key={t.vendorId} className="border-b last:border-0">
                          <td className="px-3 py-1.5 font-medium">{t.vendorName}</td>
                          <td className="px-3 py-1.5 font-mono text-xs">{t.accountNo || '—'} · {t.ifsc || '—'}</td>
                          <td className="px-3 py-1.5 text-xs">
                            {t.bills.map((x, i) => (
                              <span key={x.billId}>{i > 0 && ', '}<Link href={`/purchases/bills/${x.billId}`} className="hover:underline">{x.number}</Link></span>
                            ))}
                          </td>
                          <td className="px-3 py-1.5 text-xs">{t.mode}</td>
                          <td className="px-3 py-1.5 text-right"><Money value={t.amountPaise} /></td>
                          {b.status === 'paid' && <td className="px-3 py-1.5 font-mono text-xs">{t.paymentNumber ?? 'Returned'}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {(b.status === 'approved' || b.status === 'paid') && (
                  <Attachments targetType="payment_batch" targetId={b.id} canEdit={canCreate} title="The bank's confirmation" />
                )}

                {canCreate && (
                  <div className="flex flex-wrap items-center gap-2">
                    {(b.status === 'draft' || b.status === 'rejected') && (
                      <Button size="sm" className="gap-1.5" disabled={busy === b.id}
                        onClick={() => void act(b.id, async () => {
                          const r = await api.post<{ status: Status; approverRole?: string }>('/api/payment-batches', { action: 'submit', id: b.id });
                          if (r.status === 'pending') toast.info(`${b.number} needs ${r.approverRole} approval before the file can be made`);
                        }, `${b.number} submitted`)}>
                        <Send className="size-3.5" /> Release
                      </Button>
                    )}
                    {b.status === 'pending' && (
                      <Link href="/approvals" className="text-xs font-medium text-primary hover:underline">Open approvals</Link>
                    )}
                    {(b.status === 'approved' || b.status === 'paid') && (
                      <>
                        <Button size="sm" variant="outline" className="gap-1.5" disabled={busy === b.id} onClick={() => void download(b, 'csv')}>
                          <Download className="size-3.5" /> Bank file (CSV)
                        </Button>
                        <Button size="sm" variant="outline" className="gap-1.5" disabled={busy === b.id} onClick={() => void download(b, 'xlsx')}>
                          <FileSpreadsheet className="size-3.5" /> Excel
                        </Button>
                      </>
                    )}
                    {b.status === 'approved' && (
                      <Button size="sm" className="gap-1.5" disabled={busy === b.id} onClick={() => setPaying(b)}>Mark paid</Button>
                    )}
                    {b.fileDownloadedAt && b.status === 'approved' && (
                      <span className="text-xs text-muted-foreground">File made {new Date(b.fileDownloadedAt).toLocaleString('en-IN')}</span>
                    )}
                    {['draft', 'pending', 'approved', 'rejected'].includes(b.status) && (
                      <Button size="sm" variant="ghost" className="ml-auto gap-1" disabled={busy === b.id}
                        onClick={() => void act(b.id, () => api.post('/api/payment-batches', { action: 'cancel', id: b.id }), `${b.number} cancelled`)}>
                        <X className="size-3.5" /> Cancel batch
                      </Button>
                    )}
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </AsyncPage>

      {paying && <MarkPaid batch={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); void state.refetch(); }} />}
    </>
  );
}

/** Choose bills: due by a date, with what is left on each, and the amount to pay. */
function Builder({ banks, onClose, onCreated }: {
  banks: { id: string; name: string; hasAccountNo: boolean }[]; onClose: () => void; onCreated: () => void;
}) {
  const [payDate, setPayDate] = useState(iso(new Date()));
  const [dueBy, setDueBy] = useState(iso(new Date(Date.now() + 7 * 864e5)));
  const [bankId, setBankId] = useState(banks[0]?.id ?? '');
  const [notes, setNotes] = useState('');
  const [chosen, setChosen] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const bills = useApi(() => api.get<{ bills: PayableBill[] }>('/api/payment-batches', { view: 'bills', dueBy }), [dueBy]);

  const total = Object.values(chosen).reduce((t, v) => t + v, 0);
  const suppliers = useMemo(() => new Set((bills.data?.bills ?? []).filter((b) => b.id in chosen).map((b) => b.vendorId)).size, [bills.data, chosen]);

  const create = async () => {
    setSaving(true);
    try {
      const r = await api.post<{ number: string }>('/api/payment-batches', {
        action: 'create', bankAccountId: bankId, payDate, notes: notes || null,
        lines: Object.entries(chosen).map(([billId, amountPaise]) => ({ billId, amountPaise })),
      });
      toast.success(`${r.number} created`, { description: 'Release it to make the bank file.' });
      onCreated();
    } catch (e) {
      toast.error('Not created', { description: errorText(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">New batch</h3>
        <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close"><X className="size-4" /></Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Pay from">
          <div>
            <select value={bankId} onChange={(e) => setBankId(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              {banks.length === 0 && <option value="">No bank account</option>}
              {banks.map((b) => <option key={b.id} value={b.id}>{b.name}{b.hasAccountNo ? '' : ' (no account no.)'}</option>)}
            </select>
          </div>
        </Field>
        <Field label="Pay on"><Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} /></Field>
        <Field label="Bills due by"><Input type="date" value={dueBy} onChange={(e) => setDueBy(e.target.value)} /></Field>
        <Field label="Note"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" /></Field>
      </div>

      <AsyncPage state={bills} loading={<LoadingRows rows={3} />}>
        {(d) => d.bills.length === 0 ? (
          <p className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">No open bills due by {dmy(dueBy)}.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="w-8 px-3 py-1.5" />
                  <th className="px-3 py-1.5 font-semibold">Supplier</th>
                  <th className="px-3 py-1.5 font-semibold">Bill</th>
                  <th className="px-3 py-1.5 font-semibold">Due</th>
                  <th className="px-3 py-1.5 text-right font-semibold">Left to pay</th>
                  <th className="px-3 py-1.5 text-right font-semibold">Pay now</th>
                </tr>
              </thead>
              <tbody>
                {d.bills.map((b) => {
                  const on = b.id in chosen;
                  const blocked = !!b.inBatch;
                  return (
                    <tr key={b.id} className={cn('border-b last:border-0', blocked && 'opacity-50')}>
                      <td className="px-3 py-1.5">
                        <Checkbox checked={on} disabled={blocked} aria-label={`Pay ${b.number}`}
                          onCheckedChange={(v) => setChosen((c) => {
                            const next = { ...c };
                            if (v) next[b.id] = b.balancePaise; else delete next[b.id];
                            return next;
                          })} />
                      </td>
                      <td className="px-3 py-1.5">
                        <span className="font-medium">{b.vendorName}</span>
                        {b.isMsme && <Badge variant="outline" className="ml-2 text-[9px]">MSME</Badge>}
                        {!b.hasBankDetails && <Badge variant="outline" className="ml-2 border-destructive/40 text-[9px] text-destructive">No bank details</Badge>}
                        {blocked && <span className="ml-2 text-xs text-muted-foreground">in {b.inBatch}</span>}
                      </td>
                      <td className="px-3 py-1.5 text-xs">{b.number} · {b.vendorInvoiceNo}</td>
                      <td className={cn('px-3 py-1.5 text-xs tabular-nums', b.dueDate < iso(new Date()) && 'text-destructive')}>{dmy(b.dueDate)}</td>
                      <td className="px-3 py-1.5 text-right"><Money value={b.balancePaise} /></td>
                      <td className="px-3 py-1.5">
                        <MoneyInput valuePaise={chosen[b.id] ?? 0} className="ml-auto h-8 w-32" disabled={!on}
                          onChangePaise={(p) => setChosen((c) => ({ ...c, [b.id]: Math.min(p, b.balancePaise) }))} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </AsyncPage>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted-foreground">
          {Object.keys(chosen).length} bill(s), {suppliers} supplier(s) · <Money value={total} className="font-semibold text-foreground" />
        </span>
        <Button className="ml-auto gap-1.5" disabled={saving || !bankId || total <= 0} onClick={() => void create()}>
          {saving && <Loader2 className="size-3.5 animate-spin" />} Create batch
        </Button>
      </div>
    </Card>
  );
}

/** The bank's report back: a UTR for each transfer, and any it returned. */
function MarkPaid({ batch, onClose, onDone }: { batch: Batch; onClose: () => void; onDone: () => void }) {
  const [utr, setUtr] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const r = await api.post<{ payments: { number: string }[] }>('/api/payment-batches', {
        action: 'paid', id: batch.id, references: utr, failedVendorIds: Object.keys(failed).filter((k) => failed[k]),
      });
      toast.success(`${batch.number} paid`, { description: `Recorded ${r.payments.map((p) => p.number).join(', ')}` });
      onDone();
    } catch (e) {
      toast.error('Not recorded', { description: errorText(e) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Mark {batch.number} paid</DialogTitle>
          <DialogDescription>
            One payment is recorded per supplier on {dmy(batch.payDate)}, settling the bills in the batch. Enter the
            UTR from the bank&apos;s report; tick any transfer the bank returned and its bills stay unpaid.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {batch.transfers.map((t) => (
            <div key={t.vendorId} className="grid items-center gap-2 sm:grid-cols-[1fr_120px_180px_auto]">
              <span className="text-sm font-medium">{t.vendorName}</span>
              <Money value={t.amountPaise} className="text-right text-sm" />
              <Input placeholder="UTR" value={utr[t.vendorId] ?? ''} disabled={failed[t.vendorId]}
                onChange={(e) => setUtr({ ...utr, [t.vendorId]: e.target.value })} className="h-8 font-mono text-xs" />
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Checkbox checked={!!failed[t.vendorId]} onCheckedChange={(v) => setFailed({ ...failed, [t.vendorId]: !!v })} /> Returned
              </label>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving}>{saving ? 'Recording…' : 'Record payments'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
