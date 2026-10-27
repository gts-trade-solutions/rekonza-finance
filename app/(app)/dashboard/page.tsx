'use client';

// The dashboard, aggregated in SQL.
//
// Fifteen figures from one request rather than fifteen round trips before the
// first screen anybody sees finishes painting. Receivables and payables come
// straight off the control accounts, so these tiles and the ageing reports can
// never disagree.

import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowRight, Banknote, CheckCircle2, Clock, FileCheck2, Landmark,
  Lock, Package, Receipt, Repeat, TrendingUp, Wallet, Wrench, XCircle,
} from 'lucide-react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/page-header';
import { DateRangePicker } from '@/components/shared/date-range-picker';
import { StatTile } from '@/components/shared/stat-tile';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { ShareDonut } from '@/components/charts/share-donut';
import { RankedBars } from '@/components/charts/ranked-bars';
import { AsyncPage, LoadingRows, Refreshing } from '@/components/shared/async-state';
import { useCanSeeCosts } from '@/lib/store/hooks';
import { useSession } from '@/components/layout/session-provider';
import { today } from '@/lib/selectors';
import { describeRange, fromPreset, type RangeValue } from '@/lib/date-range';
import { formatINR, formatINRCompact } from '@/lib/money';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { CHART_COLORS, axisProps, axisRupee, rupeeFormatter, tooltipStyle } from '@/components/charts/chart-bits';

/** "42 days", or a dash when there was nothing to measure against. */
const daysText = (n: number | null) => (n === null ? '—' : `${n} day${n === 1 ? '' : 's'}`);
const trend = (now: number | null, before: number | null, window: number) =>
  now === null ? `Not enough activity in the last ${window} days`
    : before === null ? `Over the last ${window} days`
      : `${before} days, ${window} days ago`;

interface DashboardData {
  workingCapital: {
    windowDays: number; receivableDays: number | null; payableDays: number | null; inventoryDays: number | null;
    cashCycleDays: number | null;
    previous: { receivableDays: number | null; payableDays: number | null; inventoryDays: number | null };
  };
  sales: {
    billed: number; collected: number; outstanding: number; invoiceCount: number;
    customerCount: number; avgInvoice: number; paid: number; partial: number; unpaid: number;
  };
  salesPrevious: DashboardData['sales'];
  margin: { revenue: number; cogs: number; gross: number; marginPct: number; units: number; linesWithoutCost: number };
  goodsVsServices: { key: string; label: string; value: number; lines: number }[];
  billedVsCollected: { month: string; billed: number; collected: number }[];
  monthlySeries: { month: string; sales: number; expenses: number }[];
  topCustomers: { contactId: string; name: string; salesPaise: number; invoices: number; pct: number }[];
  topDebtors: { contactId: string; name: string; value: number; overdue: number; pct: number; count: number }[];
  topCreditors: DashboardData['topDebtors'];
  receivableBuckets: { bucket: string; value: number; pct: number; count: number }[];
  position: { receivablePaise: number; overduePaise: number; payablePaise: number; cashPaise: number; openInvoices: number };
  profitAndLoss: { totalIncome: number; totalExpense: number; netProfit: number; expenseRows: { name: string; value: number }[] };
  ledger: { totalDebitPaise: number; totalCreditPaise: number; balanced: boolean };
  cash: { id: string; name: string; kind: string; balancePaise: number; unmatched: number }[];
  msme: { billId: string; internalNo: string; vendorName: string; age: number; daysLeft: number; risk: string }[];
  einvoicePending: number;
  unmatchedBankLines: number;
  recentInvoices: { id: string; number: string; date: string; status: string; customerName: string; balancePaise: number }[];
}

/** Percentage change, guarding the divide-by-zero that makes dashboards lie. */
function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export default function DashboardPage() {
  const session = useSession();
  const canSeeCosts = useCanSeeCosts();
  const [range, setRange] = useState<RangeValue>(() => fromPreset('last_90', today()));

  const fyStart = useMemo(() => {
    const t = today();
    const y = Number(t.slice(0, 4)) - (Number(t.slice(5, 7)) < 4 ? 1 : 0);
    return `${y}-04-01`;
  }, []);

  const state = useApi<DashboardData>(
    () => api.get('/api/dashboard', { from: range.from, to: range.to, fyStart }),
    [range.from, range.to, fyStart],
  );

  const periodLabel = describeRange(range).toLowerCase();
  const firstName = session.user.name.split(' ')[0];

  return (
    <>
      <PageHeader
        title={`Good day, ${firstName}`}
        description={`${session.org?.name} · figures as at ${new Date(today()).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`}
        actions={
          <>
            <Refreshing active={state.refreshing} />
            <Button variant="outline" size="sm" asChild>
              <Link href="/reports">View reports</Link>
            </Button>
            <Button size="sm" asChild>
              <Link href="/sales/invoices/new">New invoice</Link>
            </Button>
          </>
        }
      />

      <AsyncPage state={state} loading={<LoadingRows rows={6} />}>
        {(d) => {
          const statusTotal = d.sales.paid + d.sales.partial + d.sales.unpaid;
          const share = (n: number) => (statusTotal ? ((n / statusTotal) * 100).toFixed(0) : '0');
          const expenseMix = d.profitAndLoss.expenseRows.map((r) => ({
            name: r.name.length > 24 ? `${r.name.slice(0, 22)}…` : r.name,
            value: r.value,
          }));

          return (
            <>
              {/* Compliance first — the India-specific value */}
              {(d.einvoicePending > 0 || d.msme.length > 0) && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {d.einvoicePending > 0 && (
                    <Link href="/gst/einvoices">
                      <Card className="flex items-center gap-3 border-amber-500/40 bg-amber-500/5 p-3.5 transition-colors hover:bg-amber-500/10">
                        <FileCheck2 className="size-5 shrink-0 text-amber-600 dark:text-amber-400" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">{d.einvoicePending} invoice(s) awaiting IRN</p>
                          <p className="text-xs text-muted-foreground">
                            B2B invoices are not legally valid without an IRN. A 30-day reporting window applies.
                          </p>
                        </div>
                        <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                      </Card>
                    </Link>
                  )}
                  {d.msme.length > 0 && (
                    <Link href="/purchases/msme-tracker">
                      <Card className="flex items-center gap-3 border-red-500/40 bg-red-500/5 p-3.5 transition-colors hover:bg-red-500/10">
                        <AlertTriangle className="size-5 shrink-0 text-red-600 dark:text-red-400" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">
                            {d.msme.length} MSME bill(s) near the 45-day limit
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Section 43B(h) disallows the expense entirely if they are not paid in time.
                          </p>
                        </div>
                        <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                      </Card>
                    </Link>
                  )}
                </div>
              )}

              {/* Position, not performance */}
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <StatTile
                  label="Receivables"
                  value={formatINRCompact(d.position.receivablePaise)}
                  sub={`${d.position.openInvoices} customers owing · ${formatINRCompact(d.position.overduePaise)} overdue`}
                  icon={Receipt}
                  tone={d.position.overduePaise > 0 ? 'warning' : 'default'}
                  href="/reports/ar-ageing"
                />
                <StatTile
                  label="Payables"
                  value={formatINRCompact(d.position.payablePaise)}
                  sub="Bills awaiting payment"
                  icon={Banknote}
                  href="/reports/ap-ageing"
                />
                <StatTile
                  label="Cash & bank"
                  value={formatINRCompact(d.position.cashPaise)}
                  sub={`Across ${d.cash.length} accounts`}
                  icon={Landmark}
                  tone="positive"
                  href="/banking"
                />
                <StatTile
                  label={d.profitAndLoss.netProfit >= 0 ? 'Profit (YTD)' : 'Loss (YTD)'}
                  value={formatINRCompact(Math.abs(d.profitAndLoss.netProfit))}
                  sub={`Income ${formatINRCompact(d.profitAndLoss.totalIncome)} − expenses ${formatINRCompact(d.profitAndLoss.totalExpense)}`}
                  icon={TrendingUp}
                  tone={d.profitAndLoss.netProfit >= 0 ? 'positive' : 'danger'}
                  href="/reports/profit-and-loss"
                />
              </div>

              {/* Working capital: how long money sits with customers, in stock, and with us */}
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <StatTile
                  label="Receivable days"
                  value={daysText(d.workingCapital.receivableDays)}
                  sub={trend(d.workingCapital.receivableDays, d.workingCapital.previous.receivableDays, d.workingCapital.windowDays)}
                  icon={Clock}
                  tone={(d.workingCapital.receivableDays ?? 0) > 60 ? 'warning' : 'default'}
                  href="/reports/ar-ageing"
                />
                <StatTile
                  label="Payable days"
                  value={daysText(d.workingCapital.payableDays)}
                  sub={(d.workingCapital.payableDays ?? 0) > 45
                    ? 'Past 45: check what is owed to MSME suppliers'
                    : trend(d.workingCapital.payableDays, d.workingCapital.previous.payableDays, d.workingCapital.windowDays)}
                  icon={Banknote}
                  tone={(d.workingCapital.payableDays ?? 0) > 45 ? 'warning' : 'default'}
                  href="/reports/ap-ageing"
                />
                <StatTile
                  label="Inventory days"
                  value={daysText(d.workingCapital.inventoryDays)}
                  sub={d.workingCapital.inventoryDays === null
                    ? 'No cost of sales posted in the last 90 days'
                    : trend(d.workingCapital.inventoryDays, d.workingCapital.previous.inventoryDays, d.workingCapital.windowDays)}
                  icon={Package}
                />
                <StatTile
                  label="Cash cycle"
                  value={daysText(d.workingCapital.cashCycleDays)}
                  sub="Receivable + inventory − payable days"
                  icon={Repeat}
                  tone={(d.workingCapital.cashCycleDays ?? 0) > 90 ? 'warning' : 'default'}
                />
              </div>

              {/* ── Sales performance ────────────────────────────────────── */}
              <div className="flex flex-wrap items-end justify-between gap-3 border-t pt-5">
                <div>
                  <h2 className="text-sm font-semibold">Sales performance</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Compared with the {periodLabel} before it. Drafts and voids are excluded throughout.
                  </p>
                </div>
                <DateRangePicker value={range} onChange={setRange} />
              </div>

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <StatTile
                  label="Total billed"
                  value={formatINRCompact(d.sales.billed)}
                  delta={pctChange(d.sales.billed, d.salesPrevious.billed)}
                  sub={`${d.sales.invoiceCount} invoices · ${d.sales.customerCount} customers`}
                  icon={Receipt}
                  href="/reports/invoice-details"
                />
                <StatTile
                  label="Collected"
                  value={formatINRCompact(d.sales.collected)}
                  delta={pctChange(d.sales.collected, d.salesPrevious.collected)}
                  sub="Cash actually received in the period"
                  icon={Wallet}
                  tone="positive"
                  href="/sales/payments"
                />
                <StatTile
                  label="Outstanding"
                  value={formatINRCompact(d.sales.outstanding)}
                  delta={pctChange(d.sales.outstanding, d.salesPrevious.outstanding)}
                  deltaGoodWhen="down"
                  sub="Unpaid, from invoices raised in the period"
                  icon={Clock}
                  tone={d.sales.outstanding > 0 ? 'warning' : 'default'}
                  href="/reports/ar-ageing"
                />
                <StatTile
                  label="Average invoice"
                  value={formatINRCompact(d.sales.avgInvoice)}
                  delta={pctChange(d.sales.avgInvoice, d.salesPrevious.avgInvoice)}
                  sub={`Across ${d.sales.invoiceCount} invoices`}
                  icon={TrendingUp}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                {[
                  { label: 'Paid', count: d.sales.paid, icon: CheckCircle2, klass: 'border-emerald-500/40 bg-emerald-500/5', ink: 'text-emerald-600 dark:text-emerald-400', hint: 'settled in full' },
                  { label: 'Partly paid', count: d.sales.partial, icon: Clock, klass: 'border-amber-500/40 bg-amber-500/5', ink: 'text-amber-600 dark:text-amber-400', hint: 'part payment received' },
                  { label: 'Unpaid', count: d.sales.unpaid, icon: XCircle, klass: 'border-red-500/40 bg-red-500/5', ink: 'text-red-600 dark:text-red-400', hint: 'nothing received yet' },
                ].map((b) => (
                  <Card key={b.label} className={`flex items-center gap-3 p-4 ${b.klass}`}>
                    <div className="min-w-0 flex-1">
                      <p className="micro-label">{b.label}</p>
                      <div className="mt-1 flex items-baseline gap-2">
                        <span className="tabular text-2xl font-semibold">{b.count}</span>
                        <span className="tabular text-xs text-muted-foreground">
                          {share(b.count)}% of {statusTotal}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">{b.hint}</p>
                    </div>
                    <b.icon className={`size-5 shrink-0 ${b.ink}`} />
                  </Card>
                ))}
              </div>

              {canSeeCosts && (
                <Card className="accent-bar p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="text-sm font-semibold">Gross margin</h2>
                        <Badge variant="outline" className="gap-1 text-[9px]">
                          <Lock className="size-2.5" /> Owner only
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Sales value less the catalogue purchase price of what went out the door.
                      </p>
                    </div>
                    <TrendingUp className="size-5 text-emerald-600 dark:text-emerald-400" />
                  </div>

                  <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <div>
                      <p className="micro-label">Gross margin</p>
                      <p className="mt-1 tabular text-2xl font-semibold text-emerald-600 dark:text-emerald-400">
                        {formatINR(d.margin.gross)}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {d.margin.marginPct.toFixed(1)}% of sales
                      </p>
                    </div>
                    <div>
                      <p className="micro-label">Revenue (excl. GST)</p>
                      <p className="mt-1 tabular text-lg font-medium">{formatINR(d.margin.revenue)}</p>
                    </div>
                    <div>
                      <p className="micro-label">Cost of goods sold</p>
                      <p className="mt-1 tabular text-lg font-medium">{formatINR(d.margin.cogs)}</p>
                    </div>
                    <div>
                      <p className="micro-label">Units sold</p>
                      <p className="mt-1 tabular text-lg font-medium">
                        {d.margin.units.toLocaleString('en-IN')}
                      </p>
                    </div>
                  </div>

                  <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
                    Indicative only — it will not agree with the Profit and Loss, because purchases are
                    expensed when billed rather than valued into stock. Use it for pricing, not for filing.
                    {d.margin.linesWithoutCost > 0 &&
                      ` ${d.margin.linesWithoutCost} line(s) have no cost price on file, so the margin is flattered by that much.`}
                  </p>
                </Card>
              )}

              {/* Billed vs collected, and what we actually sell */}
              <div className="grid gap-4 lg:grid-cols-3">
                <Card className="p-4 lg:col-span-2">
                  <div className="mb-4">
                    <h2 className="text-sm font-semibold">Billed vs collected</h2>
                    <p className="text-xs text-muted-foreground">
                      Last 6 months. The gap between the bars is money earned but not yet received.
                    </p>
                  </div>
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={d.billedVsCollected} margin={{ left: -10, right: 8, top: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                      <XAxis dataKey="month" {...axisProps} />
                      <YAxis tickFormatter={axisRupee} {...axisProps} width={64} />
                      <Tooltip formatter={rupeeFormatter} cursor={{ fill: 'var(--accent)' }} contentStyle={tooltipStyle} />
                      <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="billed" name="Billed" fill="var(--chart-1)" radius={[3, 3, 0, 0]} />
                      <Bar dataKey="collected" name="Collected" fill="var(--chart-2)" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </Card>

                <Card className="p-4">
                  <h2 className="mb-1 text-sm font-semibold">Goods vs services</h2>
                  <p className="mb-3 text-xs text-muted-foreground">
                    Taxable value for the {periodLabel}. Services carry a SAC, goods an HSN.
                  </p>
                  <ShareDonut
                    data={d.goodsVsServices.map((m) => ({ name: m.label, value: m.value }))}
                    centreLabel="Taxable"
                    emptyMessage="No invoices in this period."
                  />
                  <div className="mt-3 grid grid-cols-2 gap-2 border-t pt-3 text-xs">
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Package className="size-3.5" /> {d.goodsVsServices[0]?.lines ?? 0} goods lines
                    </div>
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Wrench className="size-3.5" /> {d.goodsVsServices[1]?.lines ?? 0} service lines
                    </div>
                  </div>
                </Card>
              </div>

              {/* Trend and expense mix */}
              <div className="grid gap-4 lg:grid-cols-3">
                <Card className="p-4 lg:col-span-2">
                  <div className="mb-4">
                    <h2 className="text-sm font-semibold">Sales vs expenses</h2>
                    <p className="text-xs text-muted-foreground">Last 6 months, excluding GST</p>
                  </div>
                  <ResponsiveContainer width="100%" height={260}>
                    <AreaChart data={d.monthlySeries} margin={{ left: -10, right: 8, top: 4 }}>
                      <defs>
                        <linearGradient id="gSales" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} />
                          <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
                        </linearGradient>
                        <linearGradient id="gExp" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--chart-5)" stopOpacity={0.3} />
                          <stop offset="100%" stopColor="var(--chart-5)" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                      <XAxis dataKey="month" {...axisProps} />
                      <YAxis tickFormatter={axisRupee} {...axisProps} width={64} />
                      <Tooltip formatter={rupeeFormatter} contentStyle={tooltipStyle} />
                      <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                      <Area type="monotone" dataKey="sales" name="Sales" stroke="var(--chart-1)" strokeWidth={2} fill="url(#gSales)" />
                      <Area type="monotone" dataKey="expenses" name="Expenses" stroke="var(--chart-5)" strokeWidth={2} fill="url(#gExp)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </Card>

                <Card className="p-4">
                  <h2 className="mb-1 text-sm font-semibold">Where the money goes</h2>
                  <p className="mb-3 text-xs text-muted-foreground">Top expense accounts, year to date</p>
                  <ShareDonut data={expenseMix} centreLabel="Expenses" emptyMessage="No expenses posted yet." />
                </Card>
              </div>

              {/* Who buys, who owes, who is owed */}
              <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
                <Card className="p-4">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-semibold">Top customers</h2>
                      <p className="text-xs text-muted-foreground">
                        Sales in the period before tax, less credit notes.
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" asChild>
                      <Link href="/reports/sales-by-customer">All <ArrowRight className="ml-1 size-3.5" /></Link>
                    </Button>
                  </div>
                  <RankedBars
                    rows={d.topCustomers.map((r) => ({
                      id: r.contactId,
                      name: r.name,
                      value: r.salesPaise,
                      pct: r.pct,
                      href: `/sales/customers/${r.contactId}`,
                      note: `${r.invoices} invoice(s)`,
                    }))}
                    emptyMessage="No sales in the period."
                  />
                </Card>

                <Card className="p-4">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-semibold">Who owes us the most</h2>
                      <p className="text-xs text-muted-foreground">
                        Debtors — share of total receivables.
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" asChild>
                      <Link href="/reports/ar-ageing">All <ArrowRight className="ml-1 size-3.5" /></Link>
                    </Button>
                  </div>
                  <RankedBars
                    rows={d.topDebtors.map((r) => ({
                      id: r.contactId,
                      name: r.name,
                      value: r.value,
                      pct: r.pct,
                      alert: r.overdue > 0,
                      href: '/reports/ar-ageing',
                      note:
                        r.overdue > 0
                          ? `${formatINR(r.overdue)} of this is past due · ${r.count} invoice(s)`
                          : `${r.count} invoice(s), none past due`,
                    }))}
                    emptyMessage="Nobody owes you anything. Enviable."
                  />
                </Card>

                <Card className="p-4">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-semibold">Who we owe the most</h2>
                      <p className="text-xs text-muted-foreground">
                        Creditors — share of total payables.
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" asChild>
                      <Link href="/reports/ap-ageing">All <ArrowRight className="ml-1 size-3.5" /></Link>
                    </Button>
                  </div>
                  <RankedBars
                    tone="warning"
                    rows={d.topCreditors.map((r) => ({
                      id: r.contactId,
                      name: r.name,
                      value: r.value,
                      pct: r.pct,
                      alert: r.overdue > 0,
                      href: '/reports/ap-ageing',
                      note:
                        r.overdue > 0
                          ? `${formatINR(r.overdue)} of this is overdue · ${r.count} bill(s)`
                          : `${r.count} bill(s), none overdue`,
                    }))}
                    emptyMessage="You owe nobody anything."
                  />
                </Card>
              </div>

              {/* Ageing buckets */}
              <Card className="p-4">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold">Outstanding by age</h2>
                    <p className="text-xs text-muted-foreground">
                      Aged from the due date. Anything past 60 days is usually a collections problem, not a
                      timing one.
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" asChild>
                    <Link href="/reports/ar-ageing">Full ageing <ArrowRight className="ml-1 size-3.5" /></Link>
                  </Button>
                </div>
                <div className="grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
                  {d.receivableBuckets.map((b, i) => (
                    <div key={b.bucket}>
                      <div className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-xs font-medium">
                          {b.bucket === 'Current' ? 'Current (not yet due)' : `${b.bucket} days overdue`}
                        </span>
                        <span className="shrink-0 tabular text-xs font-medium">{formatINR(b.value)}</span>
                        <span className="w-11 shrink-0 text-right tabular text-[11px] text-muted-foreground">
                          {b.pct.toFixed(1)}%
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.max(b.value > 0 ? 2 : 0, b.pct)}%`,
                            background: CHART_COLORS[i % CHART_COLORS.length],
                          }}
                        />
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">{b.count} customer(s)</p>
                    </div>
                  ))}
                </div>
              </Card>

              <div className="grid gap-4 lg:grid-cols-3">
                <Card className="p-4 lg:col-span-2">
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-sm font-semibold">Recent invoices</h2>
                    <Button variant="ghost" size="sm" asChild>
                      <Link href="/sales/invoices">View all <ArrowRight className="ml-1 size-3.5" /></Link>
                    </Button>
                  </div>
                  <div className="divide-y">
                    {d.recentInvoices.map((inv) => (
                      <Link
                        key={inv.id}
                        href={`/sales/invoices/${inv.id}`}
                        className="flex items-center gap-3 py-2.5 transition-colors hover:bg-accent/50"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{inv.customerName}</p>
                          <p className="text-xs text-muted-foreground">
                            {inv.number} ·{' '}
                            {new Date(inv.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
                          </p>
                        </div>
                        <StatusBadge status={inv.status as never} />
                        <Money value={inv.balancePaise} className="w-28 text-sm font-medium" />
                      </Link>
                    ))}
                  </div>
                </Card>

                <div className="space-y-4">
                  <Card className="p-4">
                    <h2 className="mb-3 text-sm font-semibold">Bank & cash</h2>
                    <div className="space-y-2">
                      {d.cash.map((c) => (
                        <div key={c.id} className="flex items-center justify-between gap-2 text-sm">
                          <span className="flex items-center gap-2 truncate text-muted-foreground">
                            <Wallet className="size-3.5 shrink-0" />
                            <span className="truncate">{c.name}</span>
                          </span>
                          <Money value={c.balancePaise} className="font-medium" />
                        </div>
                      ))}
                    </div>
                    {d.unmatchedBankLines > 0 && (
                      <Button variant="outline" size="sm" className="mt-3 w-full" asChild>
                        <Link href="/banking/reconcile">
                          {d.unmatchedBankLines} lines to reconcile
                        </Link>
                      </Button>
                    )}
                  </Card>

                  <Card className="border-emerald-500/30 bg-emerald-500/5 p-4">
                    <div className="flex items-start gap-2.5">
                      <FileCheck2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {d.ledger.balanced ? 'Books are balanced' : 'The books do NOT balance'}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Debits and credits agree to the paisa.
                        </p>
                        <div className="mt-2 flex items-center gap-2 text-xs">
                          <Badge variant="outline" className="gap-1 border-emerald-500/40">
                            Dr <Money value={d.ledger.totalDebitPaise} compact />
                          </Badge>
                          <Badge variant="outline" className="gap-1 border-emerald-500/40">
                            Cr <Money value={d.ledger.totalCreditPaise} compact />
                          </Badge>
                        </div>
                        <Button variant="link" size="sm" className="mt-1 h-auto p-0 text-xs" asChild>
                          <Link href="/reports/trial-balance">Open trial balance →</Link>
                        </Button>
                      </div>
                    </div>
                  </Card>
                </div>
              </div>
            </>
          );
        }}
      </AsyncPage>
    </>
  );
}
