'use client';

// Collections: every customer with money overdue, oldest first — the last
// follow-up, the promise to pay and whether it was kept, and when to chase
// next. Logging a call here keeps the history on the customer.

import { useState } from 'react';
import Link from 'next/link';
import { PhoneCall } from 'lucide-react';
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

interface Row {
  contactId: string; name: string; phone: string | null; email: string | null;
  overduePaise: number; totalDuePaise: number; overdueInvoices: number; oldestDays: number;
  lastFollowUp: { at: string; kind: string; note: string; by: string | null } | null;
  promise: { date: string; amountPaise: number; broken: boolean } | null;
  nextFollowup: string | null; dueToday: boolean;
}

const KINDS = ['call', 'whatsapp', 'email', 'visit', 'note'] as const;

export default function CollectionsPage() {
  const canLog = usePermission('sales', 'create');
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
        ? <div className="max-w-xs text-xs"><p className="truncate">{r.lastFollowUp.note}</p><p className="text-muted-foreground">{r.lastFollowUp.kind} · {new Date(r.lastFollowUp.at).toLocaleDateString('en-IN')}{r.lastFollowUp.by ? ` · ${r.lastFollowUp.by}` : ''}</p></div>
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
