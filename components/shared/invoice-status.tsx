'use client';

// An invoice's status as the client asked for it: Paid, Partially paid or
// Unpaid, and nothing else. Being overdue is not a fourth status but a fact
// about an unpaid balance, so it is a tag beside it: "Overdue 12 days". A draft
// and a cancelled invoice are not payable at all, and say so plainly.
//
// Drawn as Zoho draws status: capitals, 12px, in Zoho's colours, with no pill.
// The overdue tag reads as Zoho's "OVERDUE BY 12 DAYS", in Zoho's orange.

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

const LOOK: Record<PaymentStatus, { label: string; text: string }> = {
  paid: { label: 'Paid', text: 'text-success' },
  partially_paid: { label: 'Partially paid', text: 'text-success' },
  unpaid: { label: 'Unpaid', text: 'text-info' },
  draft: { label: 'Draft', text: 'text-draft' },
  cancelled: { label: 'Cancelled', text: 'text-void' },
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
    <span className={cn('inline-flex flex-wrap items-center gap-x-1.5 whitespace-nowrap text-[12px] font-medium uppercase', className)} data-slot="invoice-status" data-status={s}>
      <span className={look.text}>{look.label}</span>
      {late > 0 && (
        <span className="text-overdue" data-slot="overdue-tag">
          Overdue by {late} day{late === 1 ? '' : 's'}
        </span>
      )}
    </span>
  );
}
