'use client';

// Possible duplicate bills (status review 7, item 8): every supplier invoice
// saved although it looked like one already in the books, with what it looked
// like, why, and the reason given when it was saved. An accountant clears each
// one (not a duplicate) or confirms it (a duplicate, to be voided), with a
// note; the entry stays on the register either way, as the evidence.

import Link from 'next/link';
import { useState } from 'react';
import { CheckCircle2, Copy, RotateCcw, ScanSearch, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage } from '@/components/shared/async-state';
import { EmptyState } from '@/components/shared/empty-state';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { ApiError, duplicateReviews, type DuplicateDocView, type DuplicateReviewRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';

const dmy = (d: string) => (d ? `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}` : '');
const KIND: Record<DuplicateDocView['type'], string> = { bill: 'Bill', expense: 'Expense', goods_receipt: 'Goods receipt', invoice: 'Invoice' };

function Doc({ d }: { d: DuplicateDocView }) {
  return (
    <div className="min-w-0">
      <Link href={d.href} className="font-medium text-link hover:underline">{KIND[d.type]} {d.number}</Link>
      <span className="block text-[12px] text-muted-foreground">{d.reference ? `${d.type === 'invoice' ? 'PO' : 'Bill#'} ${d.reference} · ` : ''}{d.party} · {dmy(d.date)}</span>
      <Money value={d.totalPaise} className="text-[12px]" />{d.status === 'void' && <span className="ml-1 text-[11px] text-muted-foreground">(void)</span>}
    </div>
  );
}

export default function DuplicateBillsPage() {
  const [filter, setFilter] = useState<'open' | 'cleared' | 'confirmed' | 'all'>('open');
  const state = useApi(() => duplicateReviews.list(filter), [filter]);
  const canReview = usePermission('purchases', 'edit');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (r: DuplicateReviewRow, action: 'clear' | 'confirm' | 'reopen') => {
    setBusy(r.id);
    try {
      await duplicateReviews.review(r.id, action, notes[r.id]);
      toast.success(action === 'clear' ? 'Cleared: not a duplicate.' : action === 'confirm' ? 'Confirmed as a duplicate. Void it from the document.' : 'Reopened.');
      state.refetch();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'That did not save.');
    } finally { setBusy(null); }
  };
  const scan = async () => {
    try {
      const r = await duplicateReviews.scan();
      toast.success(r.added ? `${r.added} possible duplicate${r.added === 1 ? '' : 's'} found among the bills already entered.` : 'No other possible duplicates among the bills already entered.');
      state.refetch();
    } catch (e) { toast.error(e instanceof ApiError ? e.message : 'The scan did not run.'); }
  };

  return (
    <>
      <PageHeader
        title="Possible Duplicate Bills"
        description="Supplier invoices saved although they looked like one already in the books. Clear each one, or confirm it and void the duplicate."
        actions={canReview ? <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void scan()} data-slot="dup-scan"><ScanSearch className="size-4" /> Scan the bills</Button> : null}
      />
      <div className="mb-3 flex flex-wrap gap-1 text-[13px]" data-slot="dup-filter">
        {(['open', 'cleared', 'confirmed', 'all'] as const).map((f) => (
          <button key={f} type="button" onClick={() => setFilter(f)} data-slot={`dup-filter-${f}`}
            className={cn('rounded-full border px-3 py-1 capitalize', filter === f ? 'border-primary bg-primary text-white' : 'hover:bg-muted')}>
            {f === 'open' ? 'To review' : f}{state.data && f !== 'all' ? ` (${state.data.counts[f]})` : ''}
          </button>
        ))}
      </div>
      <p className="mb-3 text-[12.5px] text-muted-foreground">
        The same bill number from the same vendor is refused outright, however it is written (INV-001, inv001, INV/001). What lands here is the
        near miss: the same amount from the same vendor within a week under another number, a number differing only by leading zeros, or the same
        number from another contact with the same GSTIN.
      </p>
      <AsyncPage state={state}>
        {(d) => d.rows.length === 0 ? (
          <EmptyState icon={Copy} title={filter === 'open' ? 'Nothing to review' : 'Nothing here'}
            description="A bill that looks like one already in the books asks for a reason when it is saved, and then waits here for an accountant. Use Scan the bills to look over the bills entered before." />
        ) : (
          <div className="overflow-x-auto rounded-[6px] border">
            <table className="w-full text-[13px]" data-slot="dup-table">
              <thead className="bg-muted/50 text-[11.5px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Saved</th>
                  <th className="px-3 py-2 text-left font-medium">Looks like</th>
                  <th className="px-3 py-2 text-left font-medium">Why</th>
                  <th className="px-3 py-2 text-left font-medium">Reason given</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-left font-medium">Review</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.id} className="border-t align-top" data-slot="dup-row" data-status={r.status}>
                    <td className="px-3 py-2"><Doc d={r.doc} /></td>
                    <td className="px-3 py-2"><Doc d={r.twin} /></td>
                    <td className="px-3 py-2 text-[12.5px]">{r.why}</td>
                    <td className="px-3 py-2 text-[12.5px]">{r.enteredReason ?? <span className="text-muted-foreground">Found by a scan</span>}
                      {r.enteredBy && <span className="block text-[11.5px] text-muted-foreground">{r.enteredBy}, {dmy(r.createdAt.slice(0, 10))}</span>}</td>
                    <td className="px-3 py-2"><StatusBadge status={r.status === 'open' ? 'pending' : r.status} />
                      {r.reviewedBy && <span className="block text-[11.5px] text-muted-foreground">{r.reviewedBy}, {dmy((r.reviewedAt ?? '').slice(0, 10))}{r.reviewNote ? `: ${r.reviewNote}` : ''}</span>}</td>
                    <td className="px-3 py-2">
                      {canReview && r.status === 'open' ? (
                        <div className="flex min-w-[240px] flex-col gap-1.5">
                          <Input value={notes[r.id] ?? ''} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} placeholder="Note (required)" className="h-8" data-slot="dup-note" />
                          <div className="flex gap-1.5">
                            <Button size="xs" variant="outline" className="gap-1" disabled={busy === r.id} onClick={() => void act(r, 'clear')} data-slot="dup-clear"><CheckCircle2 className="size-3" /> Not a duplicate</Button>
                            <Button size="xs" variant="outline" className="gap-1 text-[#c0392b]" disabled={busy === r.id} onClick={() => void act(r, 'confirm')} data-slot="dup-confirm"><XCircle className="size-3" /> Duplicate</Button>
                          </div>
                        </div>
                      ) : canReview ? (
                        <div className="flex flex-col gap-1.5">
                          {r.status === 'confirmed' && r.doc.status !== 'void' && <Link href={r.doc.href} className="text-[12px] text-link hover:underline">Open it to void</Link>}
                          <Button size="xs" variant="ghost" className="w-fit gap-1" disabled={busy === r.id} onClick={() => void act(r, 'reopen')} data-slot="dup-reopen"><RotateCcw className="size-3" /> Reopen</Button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AsyncPage>
    </>
  );
}
