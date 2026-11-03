'use client';

// An invoice's status as the client asked for it: Paid, Partially paid or
// Unpaid, and nothing else. Being overdue is not a fourth status but a fact
// about an unpaid balance, so it is a tag beside it: "Overdue 12 days". A draft
// and a cancelled invoice are not payable at all, and say so plainly.

import { cn } from '@/lib/utils';

export type PaymentStatus = 'paid' | 'partially_paid' | 'unpaid' | 'draft' | 'cancelled';

/** The three a payable invoice can be; draft and cancelled for the two that are not. */
export function paymentStatusOf(status: string): PaymentStatus {
  if (status === 'paid') return 'paid';
  if (status === 'partially_paid') return 'partially_paid';
  if (status === 'draft') return 'draft';
  if (status === 'void') return 'cancelled';
  return 'unpaid';
}

const LOOK: Record<PaymentStatus, { label: string; dot: string; text: string }> = {
  paid: { label: 'Paid', dot: 'bg-success', text: 'text-emerald-700 dark:text-emerald-400' },
  partially_paid: { label: 'Partially paid', dot: 'bg-warning', text: 'text-amber-700 dark:text-amber-400' },
  unpaid: { label: 'Unpaid', dot: 'bg-destructive', text: 'text-red-700 dark:text-red-400' },
  draft: { label: 'Draft', dot: 'bg-muted-foreground/45', text: 'text-muted-foreground' },
  cancelled: { label: 'Cancelled', dot: 'bg-muted-foreground/30', text: 'text-muted-foreground line-through decoration-1' },
};

/** Days past the due date, or 0 when it is not yet due (or there is no balance). */
export function daysOverdue(dueDate: string | null | undefined, balancePaise: number | null | undefined, today = new Date()): number {
  if (!dueDate || !balancePaise || balancePaise <= 0) return 0;
  const due = new Date(`${dueDate.slice(0, 10)}T00:00:00`);
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.max(0, Math.round((t.getTime() - due.getTime()) / 86_400_000));
}

export function InvoiceStatus({ status, dueDate, balancePaise, className }: {
  status: string;
  dueDate?: string | null;
  balancePaise?: number | null;
  className?: string;
}) {
  const s = paymentStatusOf(status);
  const look = LOOK[s];
  const late = s === 'unpaid' || s === 'partially_paid' ? daysOverdue(dueDate, balancePaise) : 0;
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1.5 whitespace-nowrap text-[12.5px]', className)} data-slot="invoice-status" data-status={s}>
      <span className={cn('size-1.5 shrink-0 rounded-full', look.dot)} />
      <span className={cn('font-medium', look.text)}>{look.label}</span>
      {late > 0 && (
        <span className="rounded border border-red-500/40 bg-red-500/10 px-1 py-px text-[10px] font-medium text-red-700 dark:text-red-400" data-slot="overdue-tag">
          Overdue {late} day{late === 1 ? '' : 's'}
        </span>
      )}
    </span>
  );
}
