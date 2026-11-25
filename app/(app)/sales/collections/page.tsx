'use client';

// Collections: every customer with money overdue, oldest first — the last
// follow-up, the promise to pay and whether it was kept, and when to chase
// next. Logging a call here keeps the history on the customer.

import { useState } from 'react';
import Link from 'next/link';
import { History, PhoneCall } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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
import { formatINRCompact } from '@/lib/money';
import { DeleteConfirmDialog, RowActions } from '@/components/shared/row-actions';

interface Row {
  contactId: string; name: string; phone: string | null; email: string | null;
  overduePaise: number; totalDuePaise: number; overdueInvoices: number; oldestDays: number;
  lastFollowUp: { at: string; kind: string; note: string; by: string | null } | null;
  promise: { date: string; amountPaise: number; broken: boolean } | null;
  nextFollowup: string | null; dueToday: boolean;
}

const KINDS = ['call', 'whatsapp', 'email', 'visit', 'note'] as const;

interface FollowUp {
  id: string; kind: (typeof KINDS)[number]; note: string; by: string | null; at: string; invoiceNumber: string | null;
  promisedDate: string | null; promisedPaise: number | null; nextFollowup: string | null;
}

export default function CollectionsPage() {
  const canLog = usePermission('sales', 'create');
  const canEdit = usePermission('sales', 'edit');
  // A customer's follow-ups, each with Edit and Delete (a call logged against the wrong customer, a promise typed wrong).
  const [history, setHistory] = useState<Row | null>(null);
  const state = useApi(() => api.get<{ today: string; rows: Row[] }>('/api/collections'), []);
  const [filter, setFilter] = useState<'all' | 'due' | 'broken'>('due');
  const [who, setWho] = useState<Row | null>(null);
  const [f, setF] = useState({ kind: 'call' as (typeof KINDS)[number], note: '', promisedDate: '', promisedPaise: 0, nextFollowup: '' });
  const log = useApiAction((input: unknown) => api.post<{ id: string }>('/api/collections', input));

  const save = async () => {
    if (!who) return;
    const done = await log.run({
      contactId: who.contactId, kind: f.kind, note: f.note, promisedDate: f.promisedDate || null,
      promisedPaise: f.promisedPaise || null, nextFollowup: f.nextFollowup || null,
    });
    if (!done) { toast.error(log.error ?? 'Not saved'); return; }
    toast.success('Follow-up logged');
    setWho(null);
    setF({ kind: 'call', note: '', promisedDate: '', promisedPaise: 0, nextFollowup: '' });
    state.refetch();
  };

  const columns: Column<Row>[] = [
    {
      key: 'name', header: 'Customer', sortValue: (r) => r.name,
      cell: (r) => (
        <div>
          <Link href={`/sales/customers/${r.contactId}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>{r.name}</Link>
          <p className="text-xs text-muted-foreground">{[r.phone, r.email].filter(Boolean).join(' · ')}</p>
        </div>
      ),
    },
    { key: 'overdue', header: 'Overdue', align: 'right', sortValue: (r) => r.overduePaise, cell: (r) => <div className="text-right"><Money value={r.overduePaise} className="font-medium" /><p className="text-xs text-muted-foreground">{r.overdueInvoices} invoice{r.overdueInvoices === 1 ? '' : 's'}</p></div> },
    { key: 'age', header: 'Oldest', align: 'right', sortValue: (r) => r.oldestDays, cell: (r) => <span className={r.oldestDays > 60 ? 'text-destructive' : ''}>{r.oldestDays} days</span> },
    {
      key: 'last', header: 'Last follow-up', sortValue: (r) => r.lastFollowUp?.at ?? '',
      cell: (r) => (r.lastFollowUp
        ? (
          <div className="max-w-xs text-xs">
            <p className="truncate">{r.lastFollowUp.note}</p>
            <p className="text-muted-foreground">{r.lastFollowUp.kind} · {new Date(r.lastFollowUp.at).toLocaleDateString('en-IN')}{r.lastFollowUp.by ? ` · ${r.lastFollowUp.by}` : ''}</p>
            <button type="button" className="mt-0.5 inline-flex items-center gap-1 text-link hover:underline" data-slot="followup-history"
              onClick={(e) => { e.stopPropagation(); setHistory(r); }}>
              <History className="size-3" /> All follow-ups{canEdit ? ' · edit or delete' : ''}
            </button>
          </div>
        )
        : <span className="text-xs text-muted-foreground">Never chased</span>),
    },
    {
      key: 'promise', header: 'Promise to pay', sortValue: (r) => r.promise?.date ?? '',
      cell: (r) => (r.promise
        ? <div className="text-xs"><Money value={r.promise.amountPaise} /> by {new Date(r.promise.date).toLocaleDateString('en-IN')}{r.promise.broken && <Badge variant="outline" className="ml-1 border-destructive/50 text-[10px] text-destructive">Broken</Badge>}</div>
        : <span className="text-xs text-muted-foreground">—</span>),
    },
    { key: 'next', header: 'Next chase', sortValue: (r) => r.nextFollowup ?? '', cell: (r) => <span className={`text-xs ${r.dueToday ? 'font-medium text-amber-700 dark:text-amber-300' : ''}`}>{r.nextFollowup ? new Date(r.nextFollowup).toLocaleDateString('en-IN') : 'Now'}</span> },
    { key: 'x', header: '', sortValue: () => 0, cell: (r) => (canLog ? <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); setWho(r); }} className="gap-1"><PhoneCall className="size-3.5" /> Log</Button> : null) },
  ];

  return (
    <>
      <PageHeader title="Collections" description="Customers with money overdue, oldest first: the chase so far, promises to pay and whether they were kept, and who to call next." />
      <AsyncPage state={state}>
        {(d) => {
          const shown = d.rows.filter((r) => (filter === 'due' ? r.dueToday : filter === 'broken' ? r.promise?.broken : true));
          return (
            <>
              <div className="grid gap-3 sm:grid-cols-4">
                <StatTile label="Overdue" value={formatINRCompact(d.rows.reduce((t, r) => t + r.overduePaise, 0))} tone="warning" />
                <StatTile label="Customers overdue" value={String(d.rows.length)} />
                <StatTile label="To chase today" value={String(d.rows.filter((r) => r.dueToday).length)} />
                <StatTile label="Broken promises" value={String(d.rows.filter((r) => r.promise?.broken).length)} tone={d.rows.some((r) => r.promise?.broken) ? 'danger' : 'default'} />
              </div>
              <div className="flex gap-1">
                {(['due', 'broken', 'all'] as const).map((k) => (
                  <Button key={k} size="sm" variant={filter === k ? 'secondary' : 'ghost'} onClick={() => setFilter(k)}>{k === 'due' ? 'To chase today' : k === 'broken' ? 'Broken promises' : 'All overdue'}</Button>
                ))}
              </div>
              {shown.length ? <DataTable rows={shown} columns={columns} getRowId={(r) => r.contactId} searchPlaceholder="Search customers…" />
                : <EmptyState icon={PhoneCall} title="Nobody to chase here" description="Customers appear when an invoice passes its due date unpaid." />}
            </>
          );
        }}
      </AsyncPage>
      <FollowUpHistory customer={history} canEdit={canEdit} onClose={() => setHistory(null)} onChanged={() => void state.refetch()} />
      <Dialog open={!!who} onOpenChange={(o) => !o && setWho(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Log a follow-up: {who?.name}</DialogTitle>
            <DialogDescription>Kept on the customer, with the promise to pay if they made one.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="How" className="sm:col-span-2">
              <div className="flex flex-wrap gap-1">
                {KINDS.map((k) => <Button key={k} size="sm" variant={f.kind === k ? 'secondary' : 'ghost'} onClick={() => setF({ ...f, kind: k })} className="capitalize">{k}</Button>)}
              </div>
            </Field>
            <Field label="What they said" required className="sm:col-span-2"><Textarea rows={3} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Spoke to the accounts head; payment is with the director for signing." /></Field>
            <Field label="Promised to pay by"><Input type="date" value={f.promisedDate} onChange={(e) => setF({ ...f, promisedDate: e.target.value })} /></Field>
            <Field label="Promised amount"><MoneyInput valuePaise={f.promisedPaise} onChangePaise={(p) => setF({ ...f, promisedPaise: p })} /></Field>
            <Field label="Chase again on" className="sm:col-span-2" hint="Left empty, the promise date"><Input type="date" value={f.nextFollowup} onChange={(e) => setF({ ...f, nextFollowup: e.target.value })} /></Field>
          </div>
          {log.error && <p className="text-sm text-destructive">{log.error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setWho(null)}>Cancel</Button>
            <Button onClick={save} disabled={log.busy}>{log.busy ? 'Saving…' : 'Log follow-up'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Every follow-up logged for a customer, newest first, each with Edit and Delete. */
function FollowUpHistory({ customer, canEdit, onClose, onChanged }: { customer: Row | null; canEdit: boolean; onClose: () => void; onChanged: () => void }) {
  const list = useApi<{ followUps: FollowUp[] }>(
    () => (customer ? api.get('/api/collections', { contactId: customer.contactId }) : Promise.resolve({ followUps: [] })), [customer?.contactId]);
  const [editing, setEditing] = useState<FollowUp | null>(null);
  const [deleting, setDeleting] = useState<FollowUp | null>(null);
  const [f, setF] = useState({ kind: 'call' as (typeof KINDS)[number], note: '', promisedDate: '', promisedPaise: 0, nextFollowup: '' });
  const [saving, setSaving] = useState(false);
  const startEdit = (x: FollowUp) => {
    setEditing(x);
    setF({ kind: x.kind, note: x.note, promisedDate: x.promisedDate ?? '', promisedPaise: x.promisedPaise ?? 0, nextFollowup: x.nextFollowup ?? '' });
  };
  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      await api.put(`/api/collections/${editing.id}`, {
        kind: f.kind, note: f.note, promisedDate: f.promisedDate || null, promisedPaise: f.promisedPaise || null, nextFollowup: f.nextFollowup || null,
      });
      toast.success('Follow-up saved');
      setEditing(null);
      void list.refetch();
      onChanged();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <Dialog open={!!customer} onOpenChange={(o) => { if (!o) { setEditing(null); onClose(); } }}>
        <DialogContent className="sm:max-w-2xl" data-slot="followup-history-dialog">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit follow-up' : `Follow-ups: ${customer?.name ?? ''}`}</DialogTitle>
            <DialogDescription>{editing ? 'What was said, the promise to pay, and when to chase next.' : 'Newest first. The customer and the invoice a follow-up was about stay as logged.'}</DialogDescription>
          </DialogHeader>
          {editing ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="How" className="sm:col-span-2">
                <div className="flex flex-wrap gap-1">
                  {KINDS.map((k) => <Button key={k} size="sm" variant={f.kind === k ? 'secondary' : 'ghost'} onClick={() => setF({ ...f, kind: k })} className="capitalize">{k}</Button>)}
                </div>
              </Field>
              <Field label="What they said" required className="sm:col-span-2"><Textarea rows={3} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} data-slot="followup-edit-note" /></Field>
              <Field label="Promised to pay by"><Input type="date" value={f.promisedDate} onChange={(e) => setF({ ...f, promisedDate: e.target.value })} /></Field>
              <Field label="Promised amount"><MoneyInput valuePaise={f.promisedPaise} onChangePaise={(p) => setF({ ...f, promisedPaise: p })} /></Field>
              <Field label="Chase again on" className="sm:col-span-2" hint="Left empty, the promise date"><Input type="date" value={f.nextFollowup} onChange={(e) => setF({ ...f, nextFollowup: e.target.value })} /></Field>
            </div>
          ) : (
            <div className="max-h-[60vh] space-y-2 overflow-y-auto">
              {(list.data?.followUps ?? []).map((x) => (
                <div key={x.id} className="flex items-start justify-between gap-3 rounded-md border p-3 text-sm" data-slot="followup-row">
                  <div className="min-w-0">
                    <p className="whitespace-pre-line">{x.note}</p>
                    <p className="text-xs text-muted-foreground">
                      <span className="capitalize">{x.kind}</span> · {new Date(x.at).toLocaleDateString('en-IN')}{x.by ? ` · ${x.by}` : ''}{x.invoiceNumber ? ` · ${x.invoiceNumber}` : ''}
                      {x.promisedDate ? ` · promised ${x.promisedPaise ? `₹${(x.promisedPaise / 100).toLocaleString('en-IN')} ` : ''}by ${new Date(x.promisedDate).toLocaleDateString('en-IN')}` : ''}
                      {x.nextFollowup ? ` · chase ${new Date(x.nextFollowup).toLocaleDateString('en-IN')}` : ''}
                    </p>
                  </div>
                  <RowActions onEdit={canEdit ? () => startEdit(x) : null} onDelete={canEdit ? () => setDeleting(x) : null} />
                </div>
              ))}
              {list.data && !list.data.followUps.length && <p className="text-sm text-muted-foreground">No follow-ups logged.</p>}
            </div>
          )}
          <DialogFooter>
            {editing ? (
              <>
                <Button variant="outline" onClick={() => setEditing(null)}>Back</Button>
                <Button onClick={() => void save()} disabled={saving || !f.note.trim()} data-slot="followup-edit-save">{saving ? 'Saving…' : 'Save'}</Button>
              </>
            ) : <Button variant="outline" onClick={onClose}>Close</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DeleteConfirmDialog
        open={!!deleting} onOpenChange={(v) => { if (!v) setDeleting(null); }}
        title="Delete this follow-up?"
        description="It is removed from the customer's chase, with any promise to pay it recorded. The audit trail keeps a note of it."
        withReason={false}
        doneMessage="Follow-up deleted"
        onConfirm={() => api.delete(`/api/collections/${deleting!.id}`)}
        onDone={() => { void list.refetch(); onChanged(); }}
      />
    </>
  );
}
