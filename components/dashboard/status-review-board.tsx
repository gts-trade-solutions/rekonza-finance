'use client';

// Home → Auditor Review: the auditors' status review, item by item.
//
// The client's auditors returned the same fourteen items twice as "Not
// Resolved" (status reviews 6 and 7). What they could not find, or could not
// test in their own almost empty company, counted as not done. So each item is
// here in their words: what they wrote, where it is now, the test they can run
// themselves from nothing, and what this company's own records show — drawn as
// the checklist board is, in Zoho's boxes (components/dashboard/checklist-board.tsx).

import Link from 'next/link';
import { useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, ClipboardCheck, Circle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { LoadingRows } from '@/components/shared/async-state';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';

interface Item {
  n: number; module: string; issue: string; finding: string; status: 'in_use' | 'ready';
  evidence: string[]; where: { label: string; href: string }[]; test: string[];
}

export function StatusReviewBoard() {
  const allowed = usePermission('reports', 'view');
  const state = useApi(() => (allowed ? api.get<{ items: Item[] }>('/api/status-review') : Promise.resolve({ items: [] })), [allowed]);
  const [open, setOpen] = useState<number | null>(null);
  const items = state.data?.items ?? [];
  if (allowed && state.loading && !state.data) return <LoadingRows rows={6} />;
  if (!allowed) return <p className="text-sm text-muted-foreground">Your role does not include reports, so the review is not shown.</p>;
  const used = items.filter((i) => i.status === 'in_use').length;

  return (
    <section className="space-y-3" data-slot="status-review" aria-labelledby="status-review-title">
      <div className="flex items-center gap-2.5">
        <ClipboardCheck className="size-5 text-primary" />
        <div>
          <h2 id="status-review-title" className="text-[16px] font-medium">Auditors&apos; status review</h2>
          <p className="text-xs text-muted-foreground" data-slot="status-review-summary">
            The {items.length} items of the status review, in the auditors&apos; words: where each is, how to test it from an empty company, and what these books show. {used} of {items.length} have records here.
          </p>
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {items.map((i) => (
          <Card key={i.n} className="gap-0 py-0" data-slot="status-review-item" data-item={i.n} data-status={i.status}>
            <div className="flex items-start justify-between gap-2 border-b px-4 py-3">
              <div className="min-w-0">
                <p className="text-[11px] uppercase text-muted-foreground">{i.n}. {i.module}</p>
                <h3 className="text-[14px] font-medium">{i.issue}</h3>
                <p className="text-[12px] text-muted-foreground">Review said: {i.finding}</p>
              </div>
              <span className={cn('flex shrink-0 items-center gap-1 pt-0.5 text-[11px] font-medium uppercase', i.status === 'in_use' ? 'text-success' : 'text-draft')}>
                {i.status === 'in_use' ? <CheckCircle2 className="size-3.5" /> : <Circle className="size-3.5" />}
                {i.status === 'in_use' ? 'In use' : 'Ready to test'}
              </span>
            </div>
            <div className="space-y-2 px-4 pb-3 pt-2 text-[13px]">
              <ul className="space-y-0.5" data-slot="status-review-evidence">
                {i.evidence.map((e) => <li key={e} className="text-foreground">· {e}</li>)}
              </ul>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {i.where.map((w) => (
                  <Link key={w.href} href={w.href} className="text-primary hover:underline" data-slot="status-review-link">{w.label}</Link>
                ))}
              </div>
              <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setOpen(open === i.n ? null : i.n)} aria-expanded={open === i.n} data-slot="status-review-test-toggle">
                {open === i.n ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />} How to test it from an empty company
              </button>
              {open === i.n && (
                <ol className="list-decimal space-y-0.5 pl-5 text-[12.5px] text-muted-foreground" data-slot="status-review-test">
                  {i.test.map((s) => <li key={s}>{s}</li>)}
                </ol>
              )}
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}
