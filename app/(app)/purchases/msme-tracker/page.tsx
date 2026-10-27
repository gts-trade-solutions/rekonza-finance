'use client';

// Paying micro and small suppliers on time — section 15 of the MSMED Act, and
// what section 43B(h) (37(2)(g) of the 2025 Act) does when it is missed.
//
// Each supplier's deadline is its own: the period agreed in writing, never more
// than 45 days, or 15 days when nothing was agreed in writing. Medium
// enterprises and Udyam-registered traders are outside it. Past the deadline,
// whatever is still owed at the year end is not deductible that year.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Clock, Download, ShieldCheck } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { StatTile } from '@/components/shared/stat-tile';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { downloadCsv, ReportTable } from '@/components/shared/report-shell';
import { api, msmeTracker, type MsmeTrackerResponse } from '@/lib/api/client';
import { Input } from '@/components/ui/input';
import { usePermission } from '@/lib/store/hooks';
import { toast } from 'sonner';
import { useApi } from '@/lib/api/use-api';
import { formatINRCompact, toRupees } from '@/lib/money';

const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const fmt = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

export default function MsmeTrackerPage() {
  return (
    <>
      <PageHeader
        title="MSME payments"
        description="Micro and small suppliers must be paid within their agreed period — at most 45 days, or 15 without a written agreement."
      />
      <Tabs defaultValue="open">
        <TabsList>
          <TabsTrigger value="open">Bills against the clock</TabsTrigger>
          <TabsTrigger value="year">Year-end disallowance</TabsTrigger>
          <TabsTrigger value="msme1">MSME-1</TabsTrigger>
          <TabsTrigger value="interest">Interest (s.16)</TabsTrigger>
        </TabsList>
        <TabsContent value="open" className="mt-4 space-y-4"><OpenBills /></TabsContent>
        <TabsContent value="year" className="mt-4 space-y-4"><YearEnd /></TabsContent>
        <TabsContent value="msme1" className="mt-4 space-y-4"><Msme1 /></TabsContent>
        <TabsContent value="interest" className="mt-4 space-y-4"><Interest /></TabsContent>
      </Tabs>
    </>
  );
}

function OpenBills() {
  const state = useApi<MsmeTrackerResponse>(() => msmeTracker.list(), []);
  return (
    <>
      <Card className="flex items-start gap-3 border-primary/30 bg-primary/5 p-4">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          Pay a micro or small supplier after their deadline and the expense is not deductible in the year it was
          booked — only in the year it is paid. The deadline runs from the bill date: the credit period agreed in
          writing, capped at 45 days, or <strong>15 days</strong> when there is no written agreement. Set each
          supplier&apos;s category and agreement on the vendor, under MSME.
        </p>
      </Card>
      <AsyncPage state={state}>
        {(d) => (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <StatTile label="Past the deadline" value={String(d.summary.breached)} sub="Deduction lost unless paid this year"
                icon={AlertTriangle} tone={d.summary.breached ? 'danger' : 'positive'} />
              <StatTile label="Due within a week" value={String(d.summary.critical)} sub="Pay these first"
                icon={Clock} tone={d.summary.critical ? 'warning' : 'positive'} />
              <StatTile label="Value at risk" value={formatINRCompact(d.summary.atRiskPaise)} sub="Owed on those bills"
                tone={d.summary.atRiskPaise > 0 ? 'warning' : 'positive'} />
            </div>
            {(d.summary.noAgreement > 0 || d.summary.categoryUnknown > 0) && (
              <p className="text-xs text-muted-foreground">
                {d.summary.noAgreement > 0 && <>{d.summary.noAgreement} bill(s) are on 15 days because no written agreement is on file. </>}
                {d.summary.categoryUnknown > 0 && <>{d.summary.categoryUnknown} supplier(s) have no category set, so they are treated as covered.</>}
              </p>
            )}
            {d.items.length === 0 ? (
              <EmptyState icon={ShieldCheck} title="Nothing owed to micro or small suppliers"
                description="Every bill from a covered MSME has been settled." />
            ) : (
              <div className="space-y-3">
                {d.items.map((r) => {
                  const pct = Math.min(100, (r.age / r.limitDays) * 100);
                  return (
                    <Card key={r.billId} className="p-4">
                      <div className="flex flex-wrap items-start gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Link href={`/purchases/bills/${r.billId}`} className="font-medium hover:underline">{r.vendorName}</Link>
                            <Badge variant="outline" className="text-[10px]">{r.internalNo}</Badge>
                            {r.risk === 'breached' && (
                              <Badge variant="outline" className="border-red-500/40 text-[10px] text-red-600 dark:text-red-400">
                                {-r.daysLeft} day{r.daysLeft === -1 ? '' : 's'} late
                              </Badge>
                            )}
                            {r.risk === 'critical' && (
                              <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-700 dark:text-amber-300">
                                {r.daysLeft} day{r.daysLeft === 1 ? '' : 's'} left
                              </Badge>
                            )}
                            {!r.writtenAgreement && <Badge variant="outline" className="text-[10px]">No written agreement · 15 days</Badge>}
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Billed {fmt(r.date)} · pay by {fmt(r.deadline)}{r.udyamNo ? ` · ${r.udyamNo}` : ''}
                          </p>
                          <div className="mt-2.5 max-w-md">
                            <Progress value={pct} className={r.risk === 'breached' ? '[&>div]:bg-red-500' : r.risk === 'critical' ? '[&>div]:bg-amber-500' : '[&>div]:bg-emerald-500'} />
                            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                              <span>Day {r.age}</span><span>{r.limitDays}-day limit</span>
                            </div>
                          </div>
                        </div>
                        <div className="text-right">
                          <Money value={r.balancePaise} className="text-lg font-semibold" />
                          <div className="mt-2">
                            <Button size="sm" asChild><Link href={`/purchases/payments/new?bill=${r.billId}`}>Pay now</Link></Button>
                          </div>
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </>
        )}
      </AsyncPage>
    </>
  );
}

function YearEnd() {
  const lastFy = useMemo(() => { const d = new Date(); return d.getFullYear() - (d.getMonth() < 3 ? 1 : 0) - 1; }, []);
  const [fy, setFy] = useState(lastFy);
  const state = useApi(() => msmeTracker.disallowance(fy), [fy]);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={String(fy)} onValueChange={(v) => setFy(Number(v))}>
          <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[1, 0, -1, -2].map((i) => lastFy + i).map((y) => <SelectItem key={y} value={String(y)}>FY {y}-{String((y + 1) % 100).padStart(2, '0')}</SelectItem>)}
          </SelectContent>
        </Select>
        {state.data && (
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => downloadCsv(`msme-disallowance-${state.data!.fy}.csv`, [
            ['Bill', 'Supplier', 'Bill date', 'Pay by', 'Owed at year end', 'Paid by the deadline', 'Disallowed (expense)', 'Still owed'],
            ...state.data!.rows.map((r) => [r.internalNo, r.vendorName, r.date, r.deadline, toRupees(r.owedAtYearEndPaise), toRupees(r.paidInTimePaise), toRupees(r.disallowedPaise), toRupees(r.stillOwedPaise)]),
          ])}><Download className="size-3.5" /> CSV</Button>
        )}
      </div>
      <AsyncPage state={state}>
        {(d) => (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <StatTile label={`Disallowed for FY ${d.fy}`} value={formatINRCompact(d.totalDisallowedPaise)}
                sub={d.provisional ? 'Provisional: some deadlines are still running' : 'Add back in the tax computation'}
                tone={d.totalDisallowedPaise ? 'danger' : 'positive'} />
              <StatTile label="Allowed this year" value={formatINRCompact(d.totalAllowedThisYearPaise)}
                sub="Last year's disallowance, now paid" tone="positive" />
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              What was owed on {fmt(d.yearEnd)} to micro and small suppliers and not paid by its own deadline. A bill whose
              deadline fell after the year end is out of it if it was paid by then. Only the expense is disallowed, not the
              GST in the bill. For a capital purchase, the effect is on depreciation instead — check with your tax adviser.
            </p>
            {d.rows.length === 0 ? (
              <EmptyState icon={ShieldCheck} title="Nothing disallowed" description="Every covered supplier was paid in time for this year." />
            ) : (
              <ReportTable>
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className={`${th} text-left`}>Bill</th>
                    <th className={`${th} text-left`}>Pay by</th>
                    <th className={`${th} text-right`}>Owed at year end</th>
                    <th className={`${th} text-right`}>Paid in time</th>
                    <th className={`${th} text-right`}>Disallowed</th>
                    <th className={`${th} text-right`}>Still owed</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.billId} className="border-b last:border-0">
                      <td className="px-3 py-2 text-sm">{r.vendorName}<span className="block text-xs text-muted-foreground">{r.internalNo} · {fmt(r.date)}</span></td>
                      <td className="px-3 py-2 text-xs">{fmt(r.deadline)}</td>
                      <td className="px-3 py-2 text-right"><Money value={r.owedAtYearEndPaise} /></td>
                      <td className="px-3 py-2 text-right"><Money value={r.paidInTimePaise} showZero={false} /></td>
                      <td className="px-3 py-2 text-right font-medium text-destructive"><Money value={r.disallowedPaise} /></td>
                      <td className="px-3 py-2 text-right"><Money value={r.stillOwedPaise} showZero={false} /></td>
                    </tr>
                  ))}
                </tbody>
              </ReportTable>
            )}
            {d.allowedThisYear.length > 0 && (
              <Card className="p-4 text-sm">
                <p className="font-medium">Deductible this year: last year&apos;s disallowance, now paid</p>
                <ul className="mt-2 space-y-1">
                  {d.allowedThisYear.map((r) => (
                    <li key={r.billId} className="flex justify-between gap-3"><span>{r.vendorName} · {r.internalNo}</span><Money value={r.paidPaise} /></li>
                  ))}
                </ul>
              </Card>
            )}
          </>
        )}
      </AsyncPage>
    </>
  );
}

function Msme1() {
  const halves = useMemo(() => {
    const y = new Date().getFullYear();
    return [`${y}-09-30`, `${y}-03-31`, `${y - 1}-09-30`, `${y - 1}-03-31`].filter((d) => d <= new Date().toISOString().slice(0, 10));
  }, []);
  const [half, setHalf] = useState(halves[0]);
  const state = useApi(() => msmeTracker.msme1(half), [half]);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={half} onValueChange={setHalf}>
          <SelectTrigger className="h-9 w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            {halves.map((h) => <SelectItem key={h} value={h}>Half-year to {fmt(h)}</SelectItem>)}
          </SelectContent>
        </Select>
        {state.data && (
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => downloadCsv(`MSME-1-${state.data!.halfEnd}.csv`, [
            ['Supplier', 'PAN', 'Udyam', 'Bill', 'Bill date', 'Due from', 'Amount due', 'Reason for delay'],
            ...state.data!.rows.flatMap((r) => r.bills.map((b) => [r.vendorName, r.pan ?? '', r.udyamNo ?? '', b.internalNo, b.date, b.dueFrom, toRupees(b.amountPaise), ''])),
          ])}><Download className="size-3.5" /> CSV for the form</Button>
        )}
      </div>
      <AsyncPage state={state}>
        {(d) => (
          <>
            <Card className="p-4 text-sm">
              <p className="font-medium">MSME-1 for {d.period}: due by {fmt(d.dueBy)}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Companies with dues to micro or small suppliers outstanding more than 45 days file MSME-1 with the MCA each
                half-year, giving the amount, the date it became due and the reason for the delay. The reasons are yours to give;
                the CSV leaves a column for them.
              </p>
            </Card>
            {d.rows.length === 0 ? (
              <EmptyState icon={ShieldCheck} title="Nothing to report" description="No micro or small supplier was owed for more than 45 days at the half-year end." />
            ) : (
              <ReportTable>
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className={`${th} text-left`}>Supplier</th>
                    <th className={`${th} text-left`}>PAN</th>
                    <th className={`${th} text-left`}>Bills</th>
                    <th className={`${th} text-right`}>Amount due</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.vendorId} className="border-b last:border-0 align-top">
                      <td className="px-3 py-2 text-sm">{r.vendorName}{r.udyamNo && <span className="block text-[11px] text-muted-foreground">{r.udyamNo}</span>}</td>
                      <td className="px-3 py-2 font-mono text-xs">{r.pan ?? '—'}</td>
                      <td className="px-3 py-2 text-xs">{r.bills.map((b) => <span key={b.internalNo} className="block">{b.internalNo} · due from {fmt(b.dueFrom)}</span>)}</td>
                      <td className="px-3 py-2 text-right font-medium"><Money value={r.amountDuePaise} /></td>
                    </tr>
                  ))}
                </tbody>
              </ReportTable>
            )}
          </>
        )}
      </AsyncPage>
    </>
  );
}

interface InterestReport {
  fy: number; asOf: string; bankRatePct: number; ratePct: number;
  rows: { billId: string; internalNo: string; vendorName: string; date: string; deadline: string; paidLatePaise: number; interestOnPaidPaise: number; unpaidLatePaise: number; interestOnUnpaidPaise: number }[];
  disclosure: { principalUnpaidPaise: number; interestOnUnpaidPaise: number; paidLatePaise: number; interestDueOnPaidLatePaise: number; interestAccruedUnpaidPaise: number };
}

/** Interest under s.16 of the MSMED Act, and the disclosure the accounts carry. */
function Interest() {
  const thisFy = useMemo(() => { const d = new Date(); return d.getFullYear() - (d.getMonth() < 3 ? 1 : 0); }, []);
  const [fy, setFy] = useState(thisFy);
  const canSet = usePermission('settings', 'edit');
  const state = useApi<InterestReport>(() => api.get('/api/msme-tracker', { view: 'interest', fy }), [fy]);
  const setRate = async (v: number) => {
    try {
      await api.put('/api/settings/policies', { msmeBankRatePct: v });
      toast.success(`Bank rate set to ${v}%`);
      void state.refetch();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={String(fy)} onValueChange={(v) => setFy(Number(v))}>
          <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[0, -1, -2].map((i) => thisFy + i).map((y) => <SelectItem key={y} value={String(y)}>FY {y}-{String((y + 1) % 100).padStart(2, '0')}</SelectItem>)}
          </SelectContent>
        </Select>
        {state.data && (
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            RBI bank rate
            <Input type="number" step="0.05" min={1} max={19} defaultValue={state.data.bankRatePct} disabled={!canSet} className="h-9 w-24"
              onBlur={(e) => { const v = Number(e.target.value); if (v && v !== state.data!.bankRatePct) void setRate(v); }} />
            % · interest at {state.data.ratePct.toFixed(2)}% a year, compounded monthly
          </span>
        )}
      </div>
      <AsyncPage state={state}>
        {(d) => (
          <>
            <Card className="space-y-2 p-5">
              <h3 className="text-sm font-semibold">Disclosure in the accounts (Schedule III, with s.22 of the MSMED Act), to {fmt(d.asOf)}</h3>
              <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[1fr_auto]">
                <dt className="text-muted-foreground">Principal due to micro and small enterprises, unpaid past its deadline</dt><dd className="text-right"><Money value={d.disclosure.principalUnpaidPaise} /></dd>
                <dt className="text-muted-foreground">Interest due on it</dt><dd className="text-right"><Money value={d.disclosure.interestOnUnpaidPaise} /></dd>
                <dt className="text-muted-foreground">Paid in the year after the deadline</dt><dd className="text-right"><Money value={d.disclosure.paidLatePaise} /></dd>
                <dt className="text-muted-foreground">Interest due and payable for that delay</dt><dd className="text-right"><Money value={d.disclosure.interestDueOnPaidLatePaise} /></dd>
                <dt className="font-medium">Interest accrued and remaining unpaid</dt><dd className="text-right font-medium"><Money value={d.disclosure.interestAccruedUnpaidPaise} /></dd>
              </dl>
              <p className="text-xs text-muted-foreground">
                Interest paid to suppliers under s.16 is not recorded here; deduct anything paid from the last line. Under s.23 none of it is a deduction for income tax.
              </p>
            </Card>
            {d.rows.length === 0 ? (
              <EmptyState icon={ShieldCheck} title="Nothing paid late" description="No micro or small supplier was paid after their deadline in this year." />
            ) : (
              <Card className="gap-0 overflow-hidden p-0">
                <ReportTable>
                  <thead><tr className="border-b">
                    <th className={`${th} text-left`}>Bill</th><th className={`${th} text-left`}>Pay by</th>
                    <th className={`${th} text-right`}>Paid late</th><th className={`${th} text-right`}>Interest</th>
                    <th className={`${th} text-right`}>Unpaid</th><th className={`${th} text-right`}>Interest</th>
                  </tr></thead>
                  <tbody className="divide-y">
                    {d.rows.map((r) => (
                      <tr key={r.billId}>
                        <td className="px-3 py-2"><p className="font-medium">{r.vendorName}</p><p className="text-xs text-muted-foreground">{r.internalNo} · {fmt(r.date)}</p></td>
                        <td className="px-3 py-2 text-xs">{fmt(r.deadline)}</td>
                        <td className="px-3 py-2 text-right"><Money value={r.paidLatePaise} showZero={false} /></td>
                        <td className="px-3 py-2 text-right"><Money value={r.interestOnPaidPaise} showZero={false} /></td>
                        <td className="px-3 py-2 text-right"><Money value={r.unpaidLatePaise} showZero={false} /></td>
                        <td className="px-3 py-2 text-right"><Money value={r.interestOnUnpaidPaise} showZero={false} /></td>
                      </tr>
                    ))}
                  </tbody>
                </ReportTable>
              </Card>
            )}
          </>
        )}
      </AsyncPage>
    </>
  );
}
