'use client';

// Input tax credit taken back. Rule 37: suppliers not paid within 180 days,
// reversed and then taken again as they are paid. Rules 42 and 43: the share
// of common credit that belongs to exempt supplies, each month, trued up after
// the year. Each posting lands in its own GSTR-3B row.

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { ReportTable } from '@/components/shared/report-shell';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { today } from '@/lib/selectors';

interface Heads { cgst: number; sgst: number; igst: number; cess: number }
interface Rule37Row {
  billId: string; number: string; vendorName: string; billDate: string; dueBy: string; totalPaise: number; paidPaise: number;
  itc: Heads; reverse: Heads; reclaim: Heads; status: 'due' | 'reversed' | 'reclaimable' | 'reclaimed'; reversedIn: string | null;
}
interface Common {
  period: string; exemptPaise: number; turnoverPaise: number; ratio: number;
  common: Heads; rule42: Heads; capitalMonthly: Heads; rule43: Heads; posted: boolean;
}
interface Year { fy: number; exemptPaise: number; turnoverPaise: number; ratio: number; credit: Heads; due: Heads; reversed: Heads; difference: Heads; trueUpPosted: boolean }

const sum = (h: Heads) => h.cgst + h.sgst + h.igst + h.cess;
const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const fmt = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const STATUS: Record<Rule37Row['status'], { label: string; tone: string }> = {
  due: { label: 'Reverse now', tone: 'border-red-500/40 text-red-700 dark:text-red-300' },
  reversed: { label: 'Reversed', tone: 'text-muted-foreground' },
  reclaimable: { label: 'Paid: take back', tone: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300' },
  reclaimed: { label: 'Taken back', tone: 'text-muted-foreground' },
};

export default function ItcReversalsPage() {
  return (
    <>
      <PageHeader
        title="ITC reversals"
        description="Credit taken back for suppliers unpaid after 180 days (Rule 37) and for the exempt share of common credit (Rules 42 and 43)."
      />
      <Tabs defaultValue="37">
        <TabsList>
          <TabsTrigger value="37">Unpaid after 180 days</TabsTrigger>
          <TabsTrigger value="42">Exempt supplies</TabsTrigger>
        </TabsList>
        <TabsContent value="37" className="mt-4"><Rule37 /></TabsContent>
        <TabsContent value="42" className="mt-4"><Rule42 /></TabsContent>
      </Tabs>
    </>
  );
}

function useAct(refetch: () => Promise<unknown>) {
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (payload: Record<string, unknown>, done: string) => {
    setBusy(String(payload.action));
    try {
      await api.post('/api/itc-reversals', payload);
      toast.success(done);
      await refetch();
    } catch (e) {
      toast.error('Not posted', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };
  return { busy, act };
}

function Rule37() {
  const canEdit = usePermission('gst', 'edit');
  const [month, setMonth] = useState(today().slice(0, 7));
  const asOf = (() => { const [y, m] = month.split('-').map(Number); return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; })();
  const state = useApi<{ rows: Rule37Row[] }>(() => api.get('/api/itc-reversals', { view: 'rule37', asOf }), [asOf]);
  const { busy, act } = useAct(state.refetch);
  return (
    <AsyncPage state={state} loading={<LoadingRows rows={6} />}>
      {(d) => {
        const due = d.rows.filter((r) => r.status === 'due');
        const back = d.rows.filter((r) => r.status === 'reclaimable');
        return (
          <div className="space-y-4">
            <Card className="flex flex-wrap items-center gap-3 p-4 text-sm">
              <span className="text-muted-foreground">Return month</span>
              <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="h-9 w-40" />
              <span>To reverse: <Money value={due.reduce((t, r) => t + sum(r.reverse), 0)} className="font-semibold" /> on {due.length} bill(s)</span>
              <span>To take back: <Money value={back.reduce((t, r) => t + sum(r.reclaim), 0)} className="font-semibold" /></span>
              {canEdit && (
                <div className="ml-auto flex gap-2">
                  <Button size="sm" disabled={!due.length || !!busy} className="gap-1.5" onClick={() => void act({ action: 'reverse-37', month }, 'Credit reversed')}>
                    {busy === 'reverse-37' && <Loader2 className="size-3.5 animate-spin" />} Reverse in {month}
                  </Button>
                  <Button size="sm" variant="outline" disabled={!back.length || !!busy} className="gap-1.5" onClick={() => void act({ action: 'reclaim-37', month }, 'Credit taken back')}>
                    {busy === 'reclaim-37' && <Loader2 className="size-3.5 animate-spin" />} Take back paid
                  </Button>
                </div>
              )}
            </Card>
            <Card className="gap-0 overflow-hidden p-0">
              {d.rows.length === 0 ? <p className="p-6 text-center text-sm text-muted-foreground">No supplier has gone unpaid for 180 days.</p> : (
                <ReportTable>
                  <thead><tr className="border-b">
                    <th className={`${th} text-left`}>Bill</th><th className={`${th} text-left`}>180 days on</th>
                    <th className={`${th} text-right`}>Bill</th><th className={`${th} text-right`}>Paid</th>
                    <th className={`${th} text-right`}>Credit reversed</th><th className={`${th} text-right`}>To take back</th><th className={`${th} text-left`}>Status</th>
                  </tr></thead>
                  <tbody className="divide-y">
                    {d.rows.map((r) => (
                      <tr key={r.billId}>
                        <td className="px-3 py-2"><p className="font-medium">{r.vendorName}</p><p className="text-xs text-muted-foreground">{r.number} · {fmt(r.billDate)}</p></td>
                        <td className="px-3 py-2 text-xs">{fmt(r.dueBy)}</td>
                        <td className="px-3 py-2 text-right"><Money value={r.totalPaise} /></td>
                        <td className="px-3 py-2 text-right"><Money value={r.paidPaise} /></td>
                        <td className="px-3 py-2 text-right"><Money value={sum(r.reverse)} />{r.reversedIn && <p className="text-[11px] text-muted-foreground">in {r.reversedIn}</p>}</td>
                        <td className="px-3 py-2 text-right"><Money value={sum(r.reclaim)} showZero={false} /></td>
                        <td className="px-3 py-2"><Badge variant="outline" className={`text-[10px] ${STATUS[r.status].tone}`}>{STATUS[r.status].label}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </ReportTable>
              )}
            </Card>
            <p className="text-xs text-muted-foreground">
              Reversed credit goes in GSTR-3B table 4(B)(2) and is held as an asset until the supplier is paid; what is taken back goes in 4(D)(1).
              Interest under section 50 on credit used while it was not due is worked out on the portal.
            </p>
          </div>
        );
      }}
    </AsyncPage>
  );
}

function Rule42() {
  const canEdit = usePermission('gst', 'edit');
  const [month, setMonth] = useState(today().slice(0, 7));
  const fyNow = Number(today().slice(5, 7)) >= 4 ? Number(today().slice(0, 4)) : Number(today().slice(0, 4)) - 1;
  const [fy, setFy] = useState(fyNow - 1);
  const state = useApi<Common>(() => api.get('/api/itc-reversals', { view: 'common', month }), [month]);
  const year = useApi<Year>(() => api.get('/api/itc-reversals', { view: 'year', fy }), [fy]);
  const { busy, act } = useAct(async () => { await state.refetch(); await year.refetch(); });
  return (
    <div className="space-y-4">
      <AsyncPage state={state} loading={<LoadingRows rows={5} />}>
        {(c) => (
          <Card className="space-y-3 p-5">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="text-sm font-semibold">Month</h3>
              <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="h-9 w-40" />
              {c.posted && <Badge variant="outline" className="gap-1 border-emerald-500/40 text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="size-3" /> Posted</Badge>}
              {canEdit && !c.posted && (
                <Button size="sm" className="ml-auto gap-1.5" disabled={!!busy || sum(c.rule42) + sum(c.rule43) <= 0}
                  onClick={() => void act({ action: 'post-42', month }, 'Reversal posted')}>
                  {busy === 'post-42' && <Loader2 className="size-3.5 animate-spin" />} Post the reversal
                </Button>
              )}
            </div>
            <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[1fr_auto]">
              <dt className="text-muted-foreground">Exempt and nil-rated supplies (E)</dt><dd className="text-right"><Money value={c.exemptPaise} /></dd>
              <dt className="text-muted-foreground">All supplies of the registration (F)</dt><dd className="text-right"><Money value={c.turnoverPaise} /></dd>
              <dt className="text-muted-foreground">Exempt share, E ÷ F</dt><dd className="text-right tabular-nums">{(c.ratio * 100).toFixed(2)}%</dd>
              <dt className="border-t pt-1.5 text-muted-foreground">Credit on inputs and services (C2)</dt><dd className="border-t pt-1.5 text-right"><Money value={sum(c.common)} /></dd>
              <dt className="font-medium">Rule 42 reversal (D1)</dt><dd className="text-right font-medium"><Money value={sum(c.rule42)} /></dd>
              <dt className="text-muted-foreground">Capital goods: a sixtieth of their credit this month (Tm)</dt><dd className="text-right"><Money value={sum(c.capitalMonthly)} /></dd>
              <dt className="font-medium">Rule 43 reversal (Te)</dt><dd className="text-right font-medium"><Money value={sum(c.rule43)} /></dd>
            </dl>
            <p className="text-xs text-muted-foreground">
              Every input and capital good is treated as used for both kinds of supply. Credit on goods used only for exempt supplies should be
              marked ineligible on the bill instead. The reversal is a cost, booked to “ITC reversed on exempt supplies”, and goes in table 4(B)(1).
            </p>
          </Card>
        )}
      </AsyncPage>
      <AsyncPage state={year} loading={<LoadingRows rows={3} />}>
        {(y) => (
          <Card className="space-y-3 p-5">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="text-sm font-semibold">Annual true-up, Rule 42(2)</h3>
              <Select value={String(fy)} onValueChange={(v) => setFy(Number(v))}>
                <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>{[0, 1, 2].map((i) => <SelectItem key={i} value={String(fyNow - i)}>FY {fyNow - i}-{String((fyNow - i + 1) % 100).padStart(2, '0')}</SelectItem>)}</SelectContent>
              </Select>
              {y.trueUpPosted && <Badge variant="outline" className="border-emerald-500/40 text-emerald-700 dark:text-emerald-300">Posted</Badge>}
              {canEdit && !y.trueUpPosted && sum(y.difference) !== 0 && (
                <Button size="sm" className="ml-auto gap-1.5" disabled={!!busy} onClick={() => void act({ action: 'post-42-year', fy: y.fy }, 'True-up posted')}>
                  {busy === 'post-42-year' && <Loader2 className="size-3.5 animate-spin" />} Post the difference
                </Button>
              )}
            </div>
            <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[1fr_auto]">
              <dt className="text-muted-foreground">The year’s exempt share</dt><dd className="text-right tabular-nums">{(y.ratio * 100).toFixed(2)}%</dd>
              <dt className="text-muted-foreground">Due on the year’s figures</dt><dd className="text-right"><Money value={sum(y.due)} /></dd>
              <dt className="text-muted-foreground">Reversed month by month</dt><dd className="text-right"><Money value={sum(y.reversed)} /></dd>
              <dt className="font-medium">{sum(y.difference) >= 0 ? 'Still to reverse' : 'To take back'}</dt><dd className="text-right font-medium"><Money value={Math.abs(sum(y.difference))} /></dd>
            </dl>
            {sum(y.difference) > 0 && (
              <p className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> Reverse it in a return no later than September after the year; interest runs from 1 April.
              </p>
            )}
          </Card>
        )}
      </AsyncPage>
    </div>
  );
}
