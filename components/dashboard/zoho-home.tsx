'use client';

// Zoho Books' Home, measured from Zoho's own demo:
// - a header band (#fcfcfe) with the organisation's square, "Hello, <name>"
//   in 18px and the organisation under it, and the tabs along its foot
//   (15px, the open one underlined in Zoho's blue);
// - white cards with 12px corners: Total Receivables and Total Payables side
//   by side, each with the blue "current" and orange "overdue" bar; Cash Flow
//   across the page with the year's opening, incoming, outgoing and closing
//   cash beside the chart; Income and Expense with Top Expenses beside it;
//   then the bank and credit card balances.
//
// The tabs are Zoho's three and a fourth, Software Checklist: the board the
// client's reviewer reads (components/dashboard/checklist-board.tsx).

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Building2, ChevronDown, CirclePlus, Landmark, CheckCircle2, Circle } from 'lucide-react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ShareDonut } from '@/components/charts/share-donut';
import { Money } from '@/components/shared/money';
import { InvoiceStatus } from '@/components/shared/invoice-status';
import { axisProps, axisRupee, rupeeFormatter, tooltipStyle } from '@/components/charts/chart-bits';
import { formatINR } from '@/lib/money';
import { cn } from '@/lib/utils';
import { usePublishPageTitle } from '@/components/layout/page-context';

export type HomeTab = 'dashboard' | 'getting-started' | 'updates' | 'checklist';

export const HOME_TABS: { value: HomeTab; label: string }[] = [
  { value: 'dashboard', label: 'Dashboard' },
  { value: 'getting-started', label: 'Getting Started' },
  { value: 'updates', label: 'Recent Updates' },
  { value: 'checklist', label: 'Software Checklist' },
];

export interface HomeFigures {
  receivables: { totalPaise: number; currentPaise: number; overduePaise: number };
  payables: { totalPaise: number; currentPaise: number; overduePaise: number };
  cashFlow: {
    from: string; to: string; openingPaise: number; incomingPaise: number; outgoingPaise: number; closingPaise: number;
    months: { month: string; incomingPaise: number; outgoingPaise: number; closingPaise: number }[];
  };
  incomeExpense: { incomePaise: number; expensePaise: number; months: { month: string; incomePaise: number; expensePaise: number }[] };
}

const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const monthLabel = (ym: string) => new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short' });
const yearLabel = (ym: string) => ym.slice(0, 4);

/** The header band with the greeting and the tabs. */
export function HomeHeader({ name, org, fyLabel, asOf, tab, onTab }: {
  name: string;
  org: string;
  fyLabel?: string;
  asOf: string;
  tab: HomeTab;
  onTab: (t: HomeTab) => void;
}) {
  usePublishPageTitle('Home');
  return (
    <div
      data-slot="home-header"
      className="-mx-6 -mt-5 border-b bg-[#fcfcfe] px-6 pt-5 dark:bg-surface"
      style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(64,141,251,0.07) 1px, transparent 0)', backgroundSize: '22px 22px' }}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <span className="grid size-12 place-items-center rounded-md border bg-white text-muted-foreground dark:bg-muted">
            <Building2 className="size-5" strokeWidth={1.6} />
          </span>
          <div>
            <h1 className="text-[18px] font-medium leading-snug">Hello, {name}</h1>
            <p className="text-[13px] text-muted-foreground">{org}</p>
          </div>
        </div>
        <div className="text-right text-[12px] leading-relaxed text-muted-foreground">
          {fyLabel && <p className="text-[13px] text-foreground">Financial year <span className="font-medium">{fyLabel}</span></p>}
          <p>Figures as at {new Date(`${asOf}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
        </div>
      </div>
      <nav className="mt-5 flex flex-wrap gap-x-[18px]" aria-label="Home" role="tablist" data-slot="home-tabs">
        {HOME_TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            onClick={() => onTab(t.value)}
            data-tab={t.value}
            aria-selected={tab === t.value}
            className={cn(
              '-mb-px border-b-2 pb-3 pt-1 text-[15px] transition-colors',
              tab === t.value ? 'border-primary text-foreground' : 'border-transparent text-foreground/80 hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

/** A Zoho card: a 16px title on a hairline, an optional action at its right. */
function ZCard({ title, action, children, className, slot }: { title: string; action?: ReactNode; children: ReactNode; className?: string; slot?: string }) {
  return (
    <Card className={cn('gap-0 py-0', className)} data-slot={slot}>
      <div className="flex min-h-[48px] items-center justify-between gap-3 border-b px-5 py-3">
        <h2 className="text-[16px] font-medium">{title}</h2>
        {action}
      </div>
      <div className="px-5 py-4">{children}</div>
    </Card>
  );
}

function NewLink({ href }: { href: string }) {
  return (
    <Link href={href} className="flex items-center gap-1 text-[13px] text-foreground hover:text-primary">
      <CirclePlus className="size-4 fill-primary text-white" strokeWidth={1.8} /> New
    </Link>
  );
}

/** Total Receivables or Total Payables, with Zoho's current / overdue bar. */
function PartyCard({ side, figures, buckets }: {
  side: 'receivables' | 'payables';
  figures: HomeFigures['receivables'];
  buckets?: { bucket: string; value: number }[];
}) {
  const total = figures.totalPaise;
  const currentPct = total > 0 ? (figures.currentPaise / total) * 100 : 0;
  return (
    <ZCard
      title={side === 'receivables' ? 'Total Receivables' : 'Total Payables'}
      action={<NewLink href={side === 'receivables' ? '/sales/invoices/new' : '/purchases/bills/new'} />}
      slot={`home-${side}`}
    >
      <p className="text-[13px] text-[#4a4d63] dark:text-muted-foreground">{side === 'receivables' ? 'Total Unpaid Invoices' : 'Total Unpaid Bills'}</p>
      <p className="mt-1 text-[18px] font-medium tabular" data-slot="home-total">{formatINR(total)}</p>
      <div className="mt-3 flex h-3 overflow-hidden rounded-sm bg-muted" aria-hidden>
        <div className="h-full bg-[#1b6de0]" style={{ width: `${currentPct}%` }} />
        <div className="h-full bg-[#ff7a1a]" style={{ width: `${total > 0 ? 100 - currentPct : 0}%` }} />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-[15px]">
        <Link href={side === 'receivables' ? '/sales/invoices' : '/purchases/bills'} className="flex items-center gap-1.5 hover:text-primary">
          <span className="size-2.5 rounded-[2px] bg-[#1b6de0]" /> Current : <span className="tabular">{formatINR(figures.currentPaise)}</span>
        </Link>
        {buckets && buckets.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-1.5 hover:text-primary">
              <span className="size-2.5 rounded-[2px] bg-[#ff7a1a]" /> Overdue : <span className="tabular">{formatINR(figures.overduePaise)}</span>
              <ChevronDown className="size-3.5" strokeWidth={2.5} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-60">
              {buckets.filter((b) => b.bucket !== 'Current').map((b) => (
                <DropdownMenuItem key={b.bucket} className="justify-between" onClick={() => { window.location.href = '/reports/ar-ageing'; }}>
                  <span>{/days/i.test(b.bucket) ? b.bucket : `${b.bucket} days`}</span>
                  <span className="tabular">{formatINR(b.value)}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-[2px] bg-[#ff7a1a]" /> Overdue : <span className="tabular">{formatINR(figures.overduePaise)}</span>
          </span>
        )}
      </div>
    </ZCard>
  );
}

function CashFlowCard({ cf }: { cf: HomeFigures['cashFlow'] }) {
  const data = cf.months.map((m) => ({ month: monthLabel(m.month), year: yearLabel(m.month), balance: m.closingPaise / 100 }));
  const line = (dot: string, label: ReactNode, value: number, sign: string, href?: string) => (
    <div className="text-right">
      <p className="flex items-center justify-end gap-1.5 text-[13px] text-[#4a4d63] dark:text-muted-foreground">
        <span className={cn('size-2 rounded-[2px]', dot)} />
        {href ? <Link href={href} className="hover:text-primary">{label}</Link> : label}
      </p>
      <p className="mt-1 text-[16px] font-medium tabular"><span data-slot="home-cash-figure">{formatINR(value)}</span> {sign && <span className="text-[14px] font-normal">( {sign} )</span>}</p>
    </div>
  );
  return (
    <ZCard title="Cash Flow" action={<span className="flex items-center gap-1 text-[13px]">This Fiscal Year <ChevronDown className="size-3.5" /></span>} slot="home-cash-flow">
      <div className="grid gap-6 lg:grid-cols-[1fr_260px]">
        <div className="h-[260px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis dataKey="month" {...axisProps} />
              <YAxis tickFormatter={axisRupee} {...axisProps} width={64} />
              <Tooltip formatter={rupeeFormatter} contentStyle={tooltipStyle} labelFormatter={(l, p) => `${l} ${p?.[0]?.payload?.year ?? ''}`} />
              <Area type="monotone" dataKey="balance" name="Cash" stroke="#408dfb" strokeWidth={1.5} fill="#408dfb" fillOpacity={0.1} dot={{ r: 3, fill: '#1b6de0', strokeWidth: 0 }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="flex flex-col justify-center gap-5">
          {line('bg-[#b8bccb]', `Cash as on ${dmy(cf.from)}`, cf.openingPaise, '', '/reports/cash-flow')}
          {line('bg-success', 'Incoming', cf.incomingPaise, '+')}
          {line('bg-[#d6141d]', 'Outgoing', cf.outgoingPaise, '-')}
          {line('bg-[#1b6de0]', `Cash as on ${dmy(cf.to)}`, cf.closingPaise, '=', '/reports/cash-flow')}
        </div>
      </div>
    </ZCard>
  );
}

function IncomeExpenseCard({ ie }: { ie: HomeFigures['incomeExpense'] }) {
  const data = ie.months.map((m) => ({ month: monthLabel(m.month), income: m.incomePaise / 100, expense: m.expensePaise / 100 }));
  return (
    <ZCard title="Income and Expense" action={<span className="flex items-center gap-1 text-[13px]">This Fiscal Year <ChevronDown className="size-3.5" /></span>} slot="home-income-expense">
      <div className="h-[230px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ left: 0, right: 8, top: 8 }} barGap={2}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="month" {...axisProps} />
            <YAxis tickFormatter={axisRupee} {...axisProps} width={64} />
            <Tooltip formatter={rupeeFormatter} cursor={{ fill: 'var(--accent)' }} contentStyle={tooltipStyle} />
            <Bar dataKey="income" name="Income" fill="#22b378" radius={[2, 2, 0, 0]} maxBarSize={14} />
            <Bar dataKey="expense" name="Expense" fill="#f76831" radius={[2, 2, 0, 0]} maxBarSize={14} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-10 gap-y-2 border-t pt-3">
        <div>
          <p className="flex items-center gap-1.5 text-[13px] text-[#4a4d63] dark:text-muted-foreground"><span className="size-2 rounded-[2px] bg-success" /> Total Income</p>
          <p className="mt-0.5 text-[16px] font-medium tabular text-success">{formatINR(ie.incomePaise)}</p>
        </div>
        <div>
          <p className="flex items-center gap-1.5 text-[13px] text-[#4a4d63] dark:text-muted-foreground"><span className="size-2 rounded-[2px] bg-overdue" /> Total Expenses</p>
          <p className="mt-0.5 text-[16px] font-medium tabular text-overdue">{formatINR(ie.expensePaise)}</p>
        </div>
      </div>
    </ZCard>
  );
}

/** The Dashboard tab's Zoho cards. Rekonza's own widgets follow them on the page. */
export function ZohoHomeCards({ home, receivableBuckets, expenseRows, cash }: {
  home: HomeFigures;
  receivableBuckets: { bucket: string; value: number }[];
  expenseRows: { name: string; value: number }[];
  cash: { id: string; name: string; kind: string; balancePaise: number }[];
}) {
  return (
    <div className="space-y-6" data-slot="zoho-home-cards">
      <div className="grid gap-6 lg:grid-cols-2">
        <PartyCard side="receivables" figures={home.receivables} buckets={receivableBuckets} />
        <PartyCard side="payables" figures={home.payables} />
      </div>
      <CashFlowCard cf={home.cashFlow} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2"><IncomeExpenseCard ie={home.incomeExpense} /></div>
        <ZCard title="Top Expenses" action={<span className="text-[13px]">This Fiscal Year</span>} slot="home-top-expenses">
          <ShareDonut data={expenseRows.map((r) => ({ name: r.name.length > 24 ? `${r.name.slice(0, 22)}…` : r.name, value: r.value }))} height={240} emptyMessage="No expenses this year yet." />
        </ZCard>
      </div>
      <ZCard title="Bank and Credit Cards" action={<Link href="/banking" className="text-[13px] text-link hover:underline">Go to Banking</Link>} slot="home-banks">
        {cash.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">Add a bank account to see its balance here.</p>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-[11px] font-semibold uppercase text-muted-foreground">
                <th className="pb-2 text-left font-semibold">Account</th>
                <th className="pb-2 text-right font-semibold">Balance</th>
              </tr>
            </thead>
            <tbody>
              {cash.map((a) => (
                <tr key={a.id} className="border-t">
                  <td className="py-2.5">
                    <span className="flex items-center gap-2">
                      <Landmark className="size-4 text-muted-foreground" strokeWidth={1.6} />
                      <Link href="/banking" className="font-medium text-link hover:underline">{a.name}</Link>
                      <span className="text-[11px] capitalize text-muted-foreground">{a.kind}</span>
                    </span>
                  </td>
                  <td className="py-2.5 text-right"><Money value={a.balancePaise} className="font-medium" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </ZCard>
    </div>
  );
}

/** Getting Started: the steps to a working book, each ticked once it is done. */
export function GettingStarted({ steps }: { steps: { label: string; detail: string; href: string; done: boolean }[] }) {
  const done = steps.filter((s) => s.done).length;
  return (
    <Card className="gap-0 py-0" data-slot="home-getting-started">
      <div className="border-b px-5 py-4">
        <h2 className="text-[16px] font-medium">Let&apos;s get you up and running</h2>
        <p className="mt-0.5 text-[13px] text-muted-foreground">{done} of {steps.length} steps done</p>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary" style={{ width: `${(done / steps.length) * 100}%` }} /></div>
      </div>
      <ul>
        {steps.map((s) => (
          <li key={s.label} className="border-b last:border-0">
            <Link href={s.href} className="flex items-center gap-3 px-5 py-3.5 hover:bg-row-hover">
              {s.done ? <CheckCircle2 className="size-5 shrink-0 text-success" /> : <Circle className="size-5 shrink-0 text-[#c9cbd8]" />}
              <span className="min-w-0 flex-1">
                <span className={cn('block text-[14px]', s.done && 'text-muted-foreground line-through decoration-1')}>{s.label}</span>
                <span className="block text-[12px] text-muted-foreground">{s.detail}</span>
              </span>
              {!s.done && <span className="shrink-0 text-[13px] text-link">Start</span>}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Recent Updates: the latest documents in the book. */
export function RecentUpdates({ invoices }: { invoices: { id: string; number: string; date: string; dueDate?: string; status: string; customerName: string; balancePaise: number }[] }) {
  return (
    <Card className="gap-0 py-0" data-slot="home-recent-updates">
      <div className="flex items-center justify-between border-b px-5 py-4">
        <h2 className="text-[16px] font-medium">Recent invoices</h2>
        <Link href="/accountant/audit-trail" className="text-[13px] text-link hover:underline">Everything that changed</Link>
      </div>
      {invoices.length === 0 ? (
        <p className="px-5 py-6 text-[13px] text-muted-foreground">Nothing yet.</p>
      ) : (
        <table className="w-full text-[13px]">
          <tbody>
            {invoices.map((i) => (
              <tr key={i.id} className="border-b last:border-0 hover:bg-row-hover">
                <td className="px-5 py-3"><Link href={`/sales/invoices/${i.id}`} className="font-medium text-link hover:underline">{i.number}</Link></td>
                <td className="py-3">{i.customerName}</td>
                <td className="py-3 text-muted-foreground">{new Date(`${i.date.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                <td className="py-3"><InvoiceStatus status={i.status} dueDate={i.dueDate} balancePaise={i.balancePaise} /></td>
                <td className="px-5 py-3 text-right"><Money value={i.balancePaise} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
