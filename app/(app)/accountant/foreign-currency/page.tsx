'use client';

// Foreign currency: the rates the book uses — typed, or fetched each day by
// the exchange rate feed as Zoho Books does — and its open balances in other
// currencies restated at a period end's closing rate (AS 11), with the
// restatement reversed the next day.

import { useState } from 'react';
import { Loader2, Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import { ReportTable } from '@/components/shared/report-shell';
import { RowActions, withReason } from '@/components/shared/row-actions';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { today } from '@/lib/selectors';
import { dayLabel } from '@/lib/date-range';

interface Rate { id: string; currency: string; date: string; rate: number; source: string | null }

interface Data {
  asOf: string;
  rates: Rate[];
  /** Zoho's Currency Adjustments: each restatement still standing. */
  restatements: { entryId: string; entryNo: number; date: string; amountPaise: number; memo: string | null; reversedOn: string | null }[];
  feed: { enabled: boolean; lastRunOn: string | null; lastDate: string | null; lastError: string | null; lastSaved: number; currencies: string[] };
  exposure: {
    kind: 'invoice' | 'bill'; id: string; number: string; party: string; currency: string; foreignOpenPaise: number;
    bookedRate: number; carriedPaise: number; closingRate: number | null; restatedPaise: number | null; differencePaise: number | null;
  }[];
}

const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const fx = (minor: number, c: string) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: c }).format(minor / 100);

export default function ForeignCurrencyPage() {
  const canEdit = usePermission('accountant', 'edit');
  const canDelete = usePermission('accountant', 'void');
  const [asOf, setAsOf] = useState(today());
  // A rate opened to edit: its date and figure.
  const [editing, setEditing] = useState<Rate | null>(null);
  const [edit, setEdit] = useState({ date: '', rate: '' });
  const saveRate = async () => {
    if (!editing) return;
    setBusy('edit');
    try {
      await api.patch('/api/fx', { id: editing.id, date: edit.date, rate: Number(edit.rate) });
      toast.success(`${editing.currency} rate saved`);
      setEditing(null);
      await state.refetch();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };
  const state = useApi<Data>(() => api.get('/api/fx', { asOf }), [asOf]);
  const [rate, setRate] = useState({ currency: 'USD', date: today(), rate: '' });
  const [busy, setBusy] = useState<string | null>(null);

  const post = async (key: string, payload: Record<string, unknown>, done: string | ((r: never) => string)) => {
    setBusy(key);
    try {
      const r = await api.post<never>('/api/fx', payload);
      toast.success(typeof done === 'string' ? done : done(r));
      await state.refetch();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader title="Currency Adjustments" description="Exchange rates, and open invoices and bills in other currencies restated at a period end." />
      <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
        {(d) => {
          const net = d.exposure.reduce((t, r) => t + (r.kind === 'invoice' ? (r.differencePaise ?? 0) : -(r.differencePaise ?? 0)), 0);
          const missing = [...new Set(d.exposure.filter((r) => r.closingRate === null).map((r) => r.currency))];
          return (
            <div className="space-y-4">
              <Card className="space-y-3 p-5">
                <h3 className="text-sm font-semibold">Rates</h3>
                <div className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2.5 text-sm" data-slot="fx-feed">
                  <Switch id="fx-feed" checked={d.feed.enabled} disabled={!canEdit || !!busy} aria-label="Exchange rate feed"
                    onCheckedChange={(on) => void post('feed', { action: 'feed', enabled: on }, on ? 'Rates will be fetched every day' : 'Exchange rate feed switched off')} />
                  <label htmlFor="fx-feed" className="min-w-0 flex-1">
                    <span className="font-medium">Exchange rate feed</span>
                    <span className="block text-xs text-muted-foreground">
                      {d.feed.currencies.length
                        ? `Fetches each day's European Central Bank reference rate for ${d.feed.currencies.join(', ')}. A rate you type for a day is kept.`
                        : 'Fetches each day\'s reference rate for the currencies you deal in, once a customer, vendor or document uses one.'}
                      {d.feed.lastRunOn && !d.feed.lastError && d.feed.lastDate ? ` Last fetched on ${d.feed.lastRunOn} (rates of ${d.feed.lastDate}).` : ''}
                    </span>
                    {d.feed.lastError && <span className="block text-xs text-destructive" data-slot="fx-feed-error">Last fetch failed: {d.feed.lastError}</span>}
                  </label>
                  {canEdit && d.feed.currencies.length > 0 && (
                    <Button size="sm" variant="outline" className="gap-1.5" disabled={!!busy} data-slot="fx-fetch"
                      onClick={() => void post('fetch', { action: 'fetch' }, (r: { saved: { currency: string; rate: number }[]; kept: string[]; date: string | null }) =>
                        r.saved.length ? `${r.saved.map((s) => `${s.currency} ₹${s.rate}`).join(', ')} (rates of ${r.date})` : r.kept.length ? 'Your own rates for the day were kept' : 'No new rates')}>
                      {busy === 'fetch' ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Fetch now
                    </Button>
                  )}
                </div>
                {canEdit && (
                  <div className="grid gap-2 sm:grid-cols-[100px_170px_160px_auto] sm:items-end">
                    <Field label="Currency"><Input value={rate.currency} onChange={(e) => setRate({ ...rate, currency: e.target.value.toUpperCase().slice(0, 3) })} className="font-mono" /></Field>
                    <Field label="Date"><Input type="date" value={rate.date} onChange={(e) => setRate({ ...rate, date: e.target.value })} /></Field>
                    <Field label={`₹ for 1 ${rate.currency || '…'}`}><Input type="number" step="0.0001" min={0} value={rate.rate} onChange={(e) => setRate({ ...rate, rate: e.target.value })} /></Field>
                    <Button size="sm" className="gap-1.5 justify-self-start" disabled={!!busy || !(Number(rate.rate) > 0) || rate.currency.length !== 3}
                      onClick={() => void post('rate', { action: 'rate', currency: rate.currency, date: rate.date, rate: Number(rate.rate) }, 'Rate saved')}>
                      {busy === 'rate' ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Save rate
                    </Button>
                  </div>
                )}
                {d.rates.length === 0 ? <p className="text-sm text-muted-foreground">No rates yet. Add the closing rate for each currency you deal in.</p> : (
                  <ul className="divide-y rounded-md border text-sm" data-slot="fx-rates">
                    {d.rates.slice(0, 30).map((r) => (
                      <li key={r.id} className="flex flex-wrap items-center gap-4 px-3 py-1.5">
                        <span className="w-12 font-mono">{r.currency}</span><span className="w-28 text-muted-foreground">{dayLabel(r.date)}</span><span className="tabular-nums">₹{r.rate.toFixed(4)}</span>
                        {r.source && <span className="text-xs text-muted-foreground">{r.source.replace(/^Feed: /, '')}</span>}
                        <RowActions
                          className="ml-auto"
                          label={`the ${r.currency} rate of ${dayLabel(r.date)}`}
                          canEdit={canEdit}
                          canDelete={canDelete}
                          onEdit={() => { setEditing(r); setEdit({ date: r.date, rate: String(r.rate) }); }}
                          onDelete={async (reason) => { await api.delete(withReason(`/api/fx?rate=${r.id}`, reason)); await state.refetch(); }}
                          done={`${r.currency} rate of ${dayLabel(r.date)} deleted`}
                          deleteDescription="Documents keep the rate they were booked at, so nothing posted moves. The next restatement, and the next document in this currency, use the rate before it."
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              {d.restatements.length > 0 && (
                <Card className="gap-0 overflow-hidden p-0" data-slot="fx-restatements">
                  <div className="border-b px-4 py-3">
                    <h3 className="text-sm font-semibold">Currency adjustments</h3>
                    <p className="text-xs text-muted-foreground">Each restatement posted, with the day it reversed itself. Delete one made at the wrong date or rate: both halves are undone on their own dates.</p>
                  </div>
                  <ul className="divide-y text-sm">
                    {d.restatements.map((r) => (
                      <li key={r.entryId} className="flex flex-wrap items-center gap-4 px-4 py-2">
                        <span className="w-28">{dayLabel(r.date)}</span>
                        <span className="text-xs text-muted-foreground">Entry #{r.entryNo}{r.reversedOn ? ` · reversed ${dayLabel(r.reversedOn)}` : ''}</span>
                        <Money value={r.amountPaise} className="tabular-nums" />
                        <RowActions
                          className="ml-auto"
                          label={`the restatement of ${dayLabel(r.date)}`}
                          canEdit={false}
                          canDelete={canDelete}
                          onDelete={async (reason) => { await api.delete(withReason(`/api/fx?restatement=${r.entryId}`, reason)); await state.refetch(); }}
                          done={`Restatement of ${dayLabel(r.date)} deleted`}
                          deleteDescription="An entry the other way is posted on its date, and its next-day reversal is reversed, so every day nets to what it was before. The ledger keeps all of them; the date can be restated again."
                          extra={canEdit ? <span className="text-[11px] text-muted-foreground">To change it, delete it and restate again</span> : undefined}
                        />
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              <Card className="gap-0 overflow-hidden p-0">
                <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
                  <h3 className="text-sm font-semibold">Open balances on</h3>
                  <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="h-9 w-40" />
                  <span className="text-sm">Restating would be a {net >= 0 ? 'gain' : 'loss'} of <Money value={Math.abs(net)} className="font-semibold" /></span>
                  {canEdit && (
                    <Button size="sm" className="ml-auto gap-1.5" disabled={!!busy || !d.exposure.length || missing.length > 0 || net === 0}
                      onClick={() => void post('revalue', { action: 'revalue', date: asOf }, `Restated at ${asOf}, reversed on the next day`)}>
                      {busy === 'revalue' && <Loader2 className="size-3.5 animate-spin" />} Restate at closing rates
                    </Button>
                  )}
                </div>
                {missing.length > 0 && <p className="border-b px-4 py-2 text-xs text-amber-700 dark:text-amber-300">No rate on or before {asOf} for {missing.join(', ')}.</p>}
                {d.exposure.length === 0 ? <p className="p-6 text-center text-sm text-muted-foreground">Nothing open in another currency.</p> : (
                  <ReportTable>
                    <thead><tr className="border-b">
                      <th className={`${th} text-left`}>Document</th><th className={`${th} text-right`}>Open</th>
                      <th className={`${th} text-right`}>Booked at</th><th className={`${th} text-right`}>Carried</th>
                      <th className={`${th} text-right`}>Closing rate</th><th className={`${th} text-right`}>Restated</th><th className={`${th} text-right`}>Difference</th>
                    </tr></thead>
                    <tbody className="divide-y">
                      {d.exposure.map((r) => (
                        <tr key={`${r.kind}-${r.id}`}>
                          <td className="px-3 py-2"><p className="font-medium">{r.party}</p><p className="text-xs text-muted-foreground">{r.kind === 'invoice' ? 'Invoice' : 'Bill'} {r.number}</p></td>
                          <td className="px-3 py-2 text-right">{fx(r.foreignOpenPaise, r.currency)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">₹{r.bookedRate.toFixed(4)}</td>
                          <td className="px-3 py-2 text-right"><Money value={r.carriedPaise} /></td>
                          <td className="px-3 py-2 text-right tabular-nums">{r.closingRate === null ? '—' : `₹${r.closingRate.toFixed(4)}`}</td>
                          <td className="px-3 py-2 text-right">{r.restatedPaise === null ? '—' : <Money value={r.restatedPaise} />}</td>
                          <td className="px-3 py-2 text-right">{r.differencePaise === null ? '—' : <Money value={r.differencePaise} />}</td>
                        </tr>
                      ))}
                    </tbody>
                  </ReportTable>
                )}
              </Card>
              <p className="text-xs text-muted-foreground">
                Receivables and payables in another currency are restated at the closing rate for the balance sheet, and the restatement is
                reversed the next day, so each document keeps its booked value and its settlement shows the gain or loss actually made.
                Advances are not restated: they are settled in goods or services, not money.
              </p>
            </div>
          );
        }}
      </AsyncPage>
      <Dialog open={!!editing} onOpenChange={(v) => { if (!v) setEditing(null); }}>
        <DialogContent className="sm:max-w-sm" data-slot="fx-rate-edit">
          <DialogHeader>
            <DialogTitle>Edit {editing?.currency} rate</DialogTitle>
            <DialogDescription>Rupees for one {editing?.currency}. Documents already booked keep their own rate.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Date"><Input type="date" value={edit.date} onChange={(e) => setEdit({ ...edit, date: e.target.value })} /></Field>
            <Field label={`₹ for 1 ${editing?.currency ?? ''}`}><Input type="number" step="0.0001" min={0} value={edit.rate} onChange={(e) => setEdit({ ...edit, rate: e.target.value })} /></Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={() => void saveRate()} disabled={!!busy || !(Number(edit.rate) > 0) || !edit.date} data-slot="fx-rate-save">{busy === 'edit' ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
