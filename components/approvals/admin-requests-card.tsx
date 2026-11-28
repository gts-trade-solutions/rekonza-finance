'use client';

// Approvals → Requests to undo or change: what people who are not admins have
// asked to reverse, void, delete, uncategorise or change, with Approve and
// Reject for an admin (services/admin-requests.ts). Approve carries the request
// out at once, as the person who asked; Reject leaves everything as it was.
// Everyone else sees their own requests and what became of them, and may
// withdraw one still waiting.

import { useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { adminRequests, type AdminRequestRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { cn } from '@/lib/utils';

const STATUS: Record<AdminRequestRow['status'], { label: string; tone: string }> = {
  pending: { label: 'Waiting for an admin', tone: 'text-amber-700 dark:text-amber-300' },
  approved: { label: 'Approved, being done', tone: 'text-primary' },
  done: { label: 'Approved and done', tone: 'text-success' },
  rejected: { label: 'Rejected', tone: 'text-destructive' },
  failed: { label: 'Approved, but not done', tone: 'text-destructive' },
  withdrawn: { label: 'Withdrawn', tone: 'text-muted-foreground' },
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

/** Approve and Reject on one request: used here and in the bell. */
export function DecideButtons({ id, onDone, compact = false }: { id: string; onDone: () => void; compact?: boolean }) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const go = async (d: 'approve' | 'reject') => {
    setBusy(d);
    try {
      const r = await adminRequests.decide(id, d);
      if (d === 'reject') toast.success('Rejected', { description: 'Nothing was changed; they have been told.' });
      else if (r.status === 'done') toast.success('Approved and done', { description: 'They have been told.' });
      else toast.error('Approved, but the books refused it', { description: r.message ?? undefined });
      onDone();
    } catch (e) {
      toast.error('Not decided', { description: e instanceof Error ? e.message : String(e) });
      onDone();
    } finally { setBusy(null); }
  };
  return (
    <span className="flex gap-1.5" onClick={(e) => e.stopPropagation()}>
      <Button size={compact ? 'xs' : 'sm'} className="gap-1 bg-success text-white hover:bg-success/90" disabled={!!busy} onClick={() => void go('approve')} data-slot="admin-request-approve">
        {busy === 'approve' ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} Approve
      </Button>
      <Button size={compact ? 'xs' : 'sm'} variant="outline" className="gap-1 text-destructive" disabled={!!busy} onClick={() => void go('reject')} data-slot="admin-request-reject">
        {busy === 'reject' ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />} Reject
      </Button>
    </span>
  );
}

export function AdminRequestsCard({ highlight }: { highlight?: string | null }) {
  const state = useApi(() => adminRequests.list(), []);
  const [filter, setFilter] = useState('');
  const d = state.data;
  if (!d) return null;
  const rows = d.requests.filter((r) => !filter || `${r.label} ${r.requestedBy}`.toLowerCase().includes(filter.toLowerCase()));
  const waiting = d.requests.filter((r) => r.status === 'pending').length;
  if (!d.requests.length && !d.isAdmin) return null;
  return (
    <Card className="space-y-3 p-4" data-slot="admin-requests">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">{d.isAdmin ? 'Requests to undo or change' : 'My requests to undo or change'} {waiting > 0 && <span className="ml-1 rounded bg-amber-100 px-1.5 text-xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">{waiting} waiting</span>}</p>
          <p className="text-xs text-muted-foreground">
            {d.isAdmin
              ? 'Reversals, voids, deletions, uncategorised bank lines and invoice changes asked for by people who are not admins. Approve carries it out at once, as they asked it; Reject leaves everything as it is. They are told either way.'
              : 'What you asked an admin to approve, and what became of it.'}
          </p>
        </div>
        {d.requests.length > 8 && <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search requests" className="h-8 w-48" />}
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No requests yet. When someone who is not an admin reverses, voids or deletes posted work, or changes a saved invoice, it waits here for an admin.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[760px] text-sm">
            <thead><tr className="border-b bg-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground">
              {['Asked', 'By', 'To', 'Reason', 'Status', ''].map((h) => <th key={h} className="px-3 py-2 text-left font-semibold">{h}</th>)}
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={cn('border-b last:border-0 align-top', highlight === r.id && 'bg-primary/5')} data-slot="admin-request-row" data-status={r.status}>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{when(r.at)}</td>
                  <td className="px-3 py-2 text-xs">{r.requestedBy}</td>
                  <td className="px-3 py-2 font-medium">{r.label}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{r.reason ?? '—'}</td>
                  <td className="px-3 py-2 text-xs">
                    <span className={STATUS[r.status].tone}>{STATUS[r.status].label}</span>
                    {r.decidedBy && <span className="block text-muted-foreground">by {r.decidedBy}, {when(r.decidedAt)}</span>}
                    {r.note && <span className="block text-muted-foreground">“{r.note}”</span>}
                    {r.status === 'failed' && r.result && <span className="block text-destructive">{r.result}</span>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {r.status === 'pending' && d.isAdmin && <DecideButtons id={r.id} onDone={() => void state.refetch()} />}
                    {r.status === 'pending' && !d.isAdmin && (
                      <Button size="sm" variant="outline" onClick={() => void adminRequests.withdraw(r.id).then(() => state.refetch(), (e: Error) => toast.error(e.message))} data-slot="admin-request-withdraw">Withdraw</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
