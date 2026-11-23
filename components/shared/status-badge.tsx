'use client';

import { cn } from '@/lib/utils';

/*
  Status as Zoho Books shows it: the word in capitals, 12px, in the status's
  own colour and nothing else — no pill, no dot. Colours are Zoho's own:
  draft grey-green (#879697), open blue (#408dfb), paid green (#22b378),
  pending amber (#ec9500), overdue orange (#f76831), void grey (#777).
*/
type Tone = 'neutral' | 'progress' | 'caution' | 'good' | 'bad' | 'muted';

const TEXT: Record<Tone, string> = {
  neutral: 'text-draft',
  progress: 'text-info',
  caution: 'text-warning',
  good: 'text-success',
  bad: 'text-overdue',
  muted: 'text-void',
};

const TONES: Record<string, Tone> = {
  draft: 'neutral',

  approved: 'progress',
  confirmed: 'progress',
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
  inactive: 'muted',
  stopped: 'muted',
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const label = status.replace(/_/g, ' ');
  const tone = TONES[status] ?? 'neutral';
  return (
    <span className={cn('inline-flex items-center whitespace-nowrap text-[12px] font-medium uppercase', TEXT[tone], className)} data-slot="status" data-status={status}>
      {label}
    </span>
  );
}
