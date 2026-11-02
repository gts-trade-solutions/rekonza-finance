'use client';

// Balance confirmations: customers and vendors asked to confirm the balance on
// a date, their answer beside our ledger figure, and the difference. What
// auditors call circularisation; also how a vendor's account is reconciled.

import { useState } from 'react';
import { Mail, Plus, Scale } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ContactPicker } from '@/components/forms/quick-create';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { StatTile } from '@/components/shared/stat-tile';
import { AsyncPage } from '@/components/shared/async-state';
import { EmptyState } from '@/components/shared/empty-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { api } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { today } from '@/lib/selectors';

interface Row {
  id: string; contactId: string; party: string; side: 'customer' | 'vendor'; asOf: string;
  ourBalancePaise: number; theirBalancePaise: number | null; differencePaise: number | null;
  status: 'requested' | 'agreed' | 'disputed'; notes: string | null; respondedAt: string | null;
}

export default function BalanceConfirmationsPage() {
  const canEdit = usePermission('accountant', 'edit');
  const state = useApi(() => api.get<{ confirmations: Row[] }>('/api/balance-confirmations'), []);
  const mail = useApi(() => api.get<{ configured: boolean }>('/api/email'), []);
  const [asking, setAsking] = useState(false);
  const [ask, setAsk] = useState({ side: 'vendor' as 'customer' | 'vendor', contactId: '', asOf: today(), email: true });
  const [reply, setReply] = useState<Row | null>(null);
  const [answer, setAnswer] = useState({ paise: 0, notes: '' });
  const post = useApiAction((input: unknown) => api.post<{ id?: string; ourBalancePaise?: number; agreed?: boolean; differencePaise?: number }>('/api/balance-confirmations', input));

  const request = async () => {
    if (!ask.contactId) { toast.error('Pick the customer or vendor.'); return; }
    const done = await post.run({ action: 'request', contactId: ask.contactId, side: ask.side, asOf: ask.asOf });
    if (!done) { toast.error(post.error ?? 'Not recorded'); return; }
    if (ask.email && mail.data?.configured) {
      const fy = `${Number(ask.asOf.slice(0, 4)) - (Number(ask.asOf.slice(5, 7)) < 4 ? 1 : 0)}-04-01`;
      await api.post('/api/email', { kind: 'statement', contactId: ask.contactId, side: ask.side, from: fy, to: ask.asOf, message: `Please confirm your balance with us as on ${ask.asOf}. Our books show the balance in the attached statement.` })
        .then(() => toast.success('Confirmation requested and the statement emailed'))
        .catch((e: Error) => toast.warning('Recorded, but the statement was not emailed', { description: e.message }));
    } else {
      toast.success('Confirmation recorded', { description: 'Send them the statement from their page, and record their answer here.' });
    }
    setAsking(false);
    state.refetch();
  };
  const saveReply = async () => {
    if (!reply) return;
    const done = await post.run({ action: 'reply', id: reply.id, theirBalancePaise: answer.paise, notes: answer.notes || null });
    if (!done) { toast.error(post.error ?? 'Not saved'); return; }
    toast.success(done.agreed ? 'Agreed: their balance matches the books' : 'Recorded as disputed', { description: done.agreed ? undefined : 'The difference is shown against the confirmation.' });
    setReply(null);
    state.refetch();
  };

  const columns: Column<Row>[] = [
    { key: 'party', header: 'Party', sortValue: (r) => r.party, cell: (r) => <div><p className="font-medium">{r.party}</p><p className="text-xs capitalize text-muted-foreground">{r.side}</p></div> },
    { key: 'asOf', header: 'As on', sortValue: (r) => r.asOf, cell: (r) => new Date(r.asOf).toLocaleDateString('en-IN') },
    { key: 'ours', header: 'Our books', align: 'right', sortValue: (r) => r.ourBalancePaise, cell: (r) => <Money value={r.ourBalancePaise} /> },
    { key: 'theirs', header: 'Their figure', align: 'right', sortValue: (r) => r.theirBalancePaise ?? 0, cell: (r) => (r.theirBalancePaise == null ? <span className="text-xs text-muted-foreground">Awaited</span> : <Money value={r.theirBalancePaise} />) },
    { key: 'diff', header: 'Difference', align: 'right', sortValue: (r) => Math.abs(r.differencePaise ?? 0), cell: (r) => (r.differencePaise ? <Money value={r.differencePaise} className="text-destructive" /> : <span className="text-xs text-muted-foreground">—</span>) },
    {
      key: 'status', header: 'Status', sortValue: (r) => r.status,
      cell: (r) => <Badge variant={r.status === 'agreed' ? 'secondary' : 'outline'} className={`text-[10px] capitalize ${r.status === 'disputed' ? 'border-destructive/50 text-destructive' : ''}`}>{r.status}</Badge>,
    },
    { key: 'x', header: '', sortValue: () => 0, cell: (r) => (canEdit ? <Button size="sm" variant="outline" onClick={() => { setReply(r); setAnswer({ paise: r.theirBalancePaise ?? r.ourBalancePaise, notes: r.notes ?? '' }); }}>{r.status === 'requested' ? 'Record reply' : 'Change'}</Button> : null) },
  ];

  return (
    <>
      <PageHeader
        title="Balance Confirmations"
        description="Customers and vendors asked to confirm the balance on a date, their answer beside the ledger's figure, and any difference to reconcile."
        actions={canEdit ? <Button size="sm" onClick={() => setAsking(true)} className="gap-1.5"><Plus className="size-4" /> Ask for confirmation</Button> : undefined}
      />
      <AsyncPage state={state}>
        {(d) => (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <StatTile label="Awaited" value={String(d.confirmations.filter((c) => c.status === 'requested').length)} />
              <StatTile label="Agreed" value={String(d.confirmations.filter((c) => c.status === 'agreed').length)} tone="positive" />
              <StatTile label="Disputed" value={String(d.confirmations.filter((c) => c.status === 'disputed').length)} tone={d.confirmations.some((c) => c.status === 'disputed') ? 'danger' : 'default'} />
            </div>
            {d.confirmations.length ? <DataTable rows={d.confirmations} columns={columns} getRowId={(r) => r.id} searchPlaceholder="Search parties…" />
              : <EmptyState icon={Scale} title="No confirmations yet" description="Ask a vendor or customer to confirm their balance; their answer is recorded beside the books." />}
          </>
        )}
      </AsyncPage>
      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Ask for a balance confirmation</DialogTitle><DialogDescription>Our figure is taken from the ledger on the date and kept with the request.</DialogDescription></DialogHeader>
          <div className="grid gap-4">
            <Field label="Who">
              <div className="flex gap-1">{(['vendor', 'customer'] as const).map((s) => <Button key={s} size="sm" variant={ask.side === s ? 'secondary' : 'ghost'} onClick={() => setAsk({ ...ask, side: s, contactId: '' })} className="capitalize">{s}</Button>)}</div>
            </Field>
            <Field label={ask.side === 'vendor' ? 'Vendor' : 'Customer'}><ContactPicker kind={ask.side} value={ask.contactId} onChange={(v) => setAsk({ ...ask, contactId: v })} canCreate={false} /></Field>
            <Field label="Balance as on"><Input type="date" value={ask.asOf} onChange={(e) => setAsk({ ...ask, asOf: e.target.value })} /></Field>
            {mail.data?.configured && (
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={ask.email} onChange={(e) => setAsk({ ...ask, email: e.target.checked })} /> <Mail className="size-3.5" /> Email them the statement with the request</label>
            )}
          </div>
          {post.error && <p className="text-sm text-destructive">{post.error}</p>}
          <DialogFooter><Button variant="outline" onClick={() => setAsking(false)}>Cancel</Button><Button onClick={request} disabled={post.busy}>Record request</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!reply} onOpenChange={(o) => !o && setReply(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Their reply: {reply?.party}</DialogTitle><DialogDescription>Our books show <Money value={reply?.ourBalancePaise ?? 0} /> on {reply?.asOf}.</DialogDescription></DialogHeader>
          <div className="grid gap-4">
            <Field label="Balance as per their books"><MoneyInput valuePaise={answer.paise} onChangePaise={(p) => setAnswer({ ...answer, paise: p })} /></Field>
            <Field label="Notes" hint="What makes up any difference"><Input value={answer.notes} onChange={(e) => setAnswer({ ...answer, notes: e.target.value })} /></Field>
          </div>
          {post.error && <p className="text-sm text-destructive">{post.error}</p>}
          <DialogFooter><Button variant="outline" onClick={() => setReply(null)}>Cancel</Button><Button onClick={saveReply} disabled={post.busy}>Save reply</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
