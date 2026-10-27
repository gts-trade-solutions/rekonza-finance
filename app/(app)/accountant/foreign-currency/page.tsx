'use client';

// Foreign currency: the rates the book uses, and its open balances in other
// currencies restated at a period end's closing rate (AS 11), with the
// restatement reversed the next day.

import { useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import { ReportTable } from '@/components/shared/report-shell';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { today } from '@/lib/selectors';

interface Data {
  asOf: string;
  rates: { id: string; currency: string; date: string; rate: number; source: string | null }[];
  exposure: {
    kind: 'invoice' | 'bill'; id: string; number: string; party: string; currency: string; foreignOpenPaise: number;
    bookedRate: number; carriedPaise: number; closingRate: number | null; restatedPaise: number | null; differencePaise: number | null;
  }[];
}

const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const fx = (minor: number, c: string) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: c }).format(minor / 100);

export default function ForeignCurrencyPage() {
  const canEdit = usePermission('accountant', 'edit');
  const [asOf, setAsOf] = useState(today());
  const state = useApi<Data>(() => api.get('/api/fx', { asOf }), [asOf]);
  const [rate, setRate] = useState({ currency: 'USD', date: today(), rate: '' });
  const [busy, setBusy] = useState<string | null>(null);

  const post = async (key: string, payload: Record<string, unknown>, done: string) => {
    setBusy(key);
    try {
      await api.post('/api/fx', payload);
      toast.success(done);
      await state.refetch();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader title="Foreign currency" description="Exchange rates, and open invoices and bills in other currencies restated at a period end." />
      <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
        {(d) => {
          const net = d.exposure.reduce((t, r) => t + (r.kind === 'invoice' ? (r.differencePaise ?? 0) : -(r.differencePaise ?? 0)), 0);
          const missing = [...new Set(d.exposure.filter((r) => r.closingRate === null).map((r) => r.currency))];
          return (
            <div className="space-y-4">
              <Card className="space-y-3 p-5">
                <h3 className="text-sm font-semibold">Rates</h3>
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
                  <ul className="divide-y rounded-md border text-sm">
                    {d.rates.slice(0, 12).map((r) => (
                      <li key={r.id} className="flex gap-4 px-3 py-1.5">
                        <span className="w-12 font-mono">{r.currency}</span><span className="w-28 text-muted-foreground">{r.date}</span><span className="tabular-nums">₹{r.rate.toFixed(4)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

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
    </>
  );
}
