'use client';

import { cn } from '@/lib/utils';

/*
  Status reads as a small dot plus quiet type, not a saturated pill. In a table
  of thirty rows, thirty coloured pills become noise and the eye stops seeing
  the one row that actually needs attention. The dot carries the colour; the
  label stays ink.
*/
type Tone = 'neutral' | 'progress' | 'caution' | 'good' | 'bad' | 'muted';

const DOT: Record<Tone, string> = {
  neutral: 'bg-muted-foreground/45',
  progress: 'bg-info',
  caution: 'bg-warning',
  good: 'bg-success',
  bad: 'bg-destructive',
  muted: 'bg-muted-foreground/30',
};

const TEXT: Record<Tone, string> = {
  neutral: 'text-muted-foreground',
  progress: 'text-foreground/75',
  caution: 'text-foreground/75',
  good: 'text-foreground/75',
  bad: 'text-destructive',
  muted: 'text-muted-foreground',
};

const TONES: Record<string, Tone> = {
  draft: 'neutral',

  approved: 'progress',
  sent: 'progress',
  open: 'progress',
  issued: 'progress',
  deposited: 'progress',

  partially_paid: 'caution',
  partially_invoiced: 'caution',
  partially_applied: 'caution',
  pending: 'caution',
  in_hand: 'caution',
  missing_in_books: 'caution',

  paid: 'good',
  cleared: 'good',
  accepted: 'good',
  matched: 'good',
  submitted: 'good',
  applied: 'good',
  invoiced: 'good',
  billed: 'good',
  converted: 'good',
  recorded: 'good',
  active: 'good',

  overdue: 'bad',
  failed: 'bad',
  bounced: 'bad',
  declined: 'bad',
  mismatch: 'bad',
  missing_in_2b: 'bad',

  void: 'muted',
  cancelled: 'muted',
  expired: 'muted',
  excluded: 'muted',
  closed: 'muted',
  unmatched: 'muted',
  not_applicable: 'muted',
  written_off: 'muted',
  refunded: 'muted',
  returned: 'muted',
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const label = status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const tone = TONES[status] ?? 'neutral';
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px]', className)}>
      <span className={cn('size-1.5 shrink-0 rounded-full', DOT[tone])} />
      <span className={cn(TEXT[tone], tone === 'muted' && 'line-through decoration-1')}>{label}</span>
    </span>
  );
}
