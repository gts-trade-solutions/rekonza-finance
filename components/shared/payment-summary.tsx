'use client';

// Zoho Books' "PAYMENT SUMMARY" box over the invoice and bill lists: a pale
// box (#f9f9fb, #ebeaf2 hairline, 10px corners) with the total outstanding
// beside a round icon, then what falls due today, within 30 days, and what is
// already overdue — dotted apart, as Zoho lays them out.
//
// The figures are worked out from every open document (not the view the list
// is showing), as Zoho's are: a summary of what is owed should not change when
// the list is filtered to paid invoices.

import type { ReactNode } from 'react';
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { formatINR } from '@/lib/money';
import { cn } from '@/lib/utils';

export interface OpenDoc {
  dueDate: string;
  balancePaise: number;
  status?: string;
}

function iso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Totals by when they fall due, from today's date. Drafts and void documents owe nothing. */
export function summarise(docs: OpenDoc[], today = new Date()) {
  const t = iso(today);
  const in30 = iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 30));
  let total = 0, dueToday = 0, within30 = 0, overdue = 0;
  for (const d of docs) {
    if (d.balancePaise <= 0 || d.status === 'draft' || d.status === 'void') continue;
    const due = d.dueDate.slice(0, 10);
    total += d.balancePaise;
    if (due < t) overdue += d.balancePaise;
    else if (due === t) dueToday += d.balancePaise;
    else if (due <= in30) within30 += d.balancePaise;
  }
  return { total, dueToday, within30, overdue };
}

export function PaymentSummary({
  side,
  docs,
  extra,
}: {
  side: 'receivables' | 'payables';
  docs: OpenDoc[] | null;
  /** Rekonza's own figures, after Zoho's (e-invoices awaiting an IRN, MSME bills at risk). */
  extra?: { label: string; value: ReactNode; tone?: 'warning' | 'danger' }[];
}) {
  const s = summarise(docs ?? []);
  const Icon = side === 'receivables' ? ArrowDownLeft : ArrowUpRight;
  const cell = (label: string, value: ReactNode, cls?: string) => (
    <div className="min-w-0">
      <p className="truncate text-[14px] text-[#21263c] dark:text-foreground">{label}</p>
      <p className={cn('mt-1 text-[16px] font-medium tabular', cls)}>{value}</p>
    </div>
  );
  return (
    <div className="rounded-[10px] border bg-table-head px-5 py-4" data-slot="payment-summary">
      <p className="text-[12px] font-medium uppercase text-muted-foreground">Payment Summary</p>
      <div className="mt-3 flex flex-wrap items-center gap-x-8 gap-y-4">
        <div className="flex min-w-[220px] items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[#f3c482] text-[#9e4b03]">
            <Icon className="size-5" strokeWidth={2.2} />
          </span>
          {cell(side === 'receivables' ? 'Total Outstanding Receivables' : 'Total Outstanding Payables', docs ? formatINR(s.total) : '…')}
        </div>
        <Dot />
        {cell('Due Today', docs ? formatINR(s.dueToday) : '…', 'text-warning')}
        <Dot />
        {cell('Due Within 30 Days', docs ? formatINR(s.within30) : '…')}
        <Dot />
        {cell(side === 'receivables' ? 'Overdue Invoice' : 'Overdue Bill', docs ? formatINR(s.overdue) : '…', s.overdue > 0 ? 'text-overdue' : undefined)}
        {extra?.map((x) => (
          <span key={x.label} className="contents">
            <Dot />
            {cell(x.label, x.value, x.tone === 'danger' ? 'text-overdue' : x.tone === 'warning' ? 'text-warning' : undefined)}
          </span>
        ))}
      </div>
    </div>
  );
}

function Dot() {
  return <span aria-hidden className="hidden size-1 shrink-0 rounded-full bg-[#c9cbd8] sm:block" />;
}
