'use client';

// The exceptions register (lib/server/services/exceptions.ts): everything the
// scheduler found wrong, each with an owner and a date, escalated when the date
// passes and closed with a resolution — or by itself, when the problem goes away.

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AlertOctagon, ArrowUpRight, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage } from '@/components/shared/async-state';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { api, ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { EXCEPTION_KINDS, type ExceptionKind, type ExceptionSeverity, type ExceptionStatus } from '@/lib/exceptions';
import { cn } from '@/lib/utils';

interface Row {
  id: string; kind: ExceptionKind; area: string; label: string; title: string; detail: string | null;
  severity: ExceptionSeverity; status: ExceptionStatus; amountPaise: number | null; href: string | null;
  ownerId: string | null; ownerName: string | null; detectedAt: string; dueAt: string | null; overdue: boolean;
  escalationLevel: number; closedAt: string | null; resolution: string | null; stillPresent: boolean;
}
interface ListResponse {
  exceptions: Row[];
  summary: { active: number; critical: number; high: number; closed: number };
  canManage: boolean; me: string;
  users: { id: string; name: string; role: string }[];
}
interface Detail { exception: Row; events: { id: string; action: string; note: string | null; at: string; by: string }[] }

const SEVERITY: Record<ExceptionSeverity, string> = {
  critical: 'border-red-600/50 bg-red-500/10 text-red-700 dark:text-red-400',
  high: 'border-orange-500/50 bg-orange-500/10 text-orange-700 dark:text-orange-400',
  medium: 'border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400',
  low: 'border-border text-muted-foreground',
};
const STATUS_LABEL: Record<ExceptionStatus, string> = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved', waived: 'Waived' };
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const at = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function ExceptionsPage() {
  const [view, setView] = useState<'active' | 'mine' | 'closed'>('active');
  const [kind, setKind] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('id')) setOpenId(p.get('id'));
    if (p.get('kind')) setKind(p.get('kind') ?? '');
  }, []);

  const state = useApi<ListResponse>(() => api.get('/api/exceptions', {
    view: view === 'closed' ? 'closed' : 'active', mine: view === 'mine' ? true : undefined, kind: kind || undefined,
  }), [view, kind]);

  const scan = async () => {
    setScanning(true);
    try {
      const r = await api.post<{ raised: number; cleared: number; escalated: number }>('/api/exceptions');
      toast.success('Checked now', { description: `${r.raised} raised, ${r.cleared} cleared, ${r.escalated} escalated.` });
      await state.refetch();
    } catch (e) {
      toast.error('Could not check', { description: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setScanning(false);
    }
  };

  const columns: Column<Row>[] = [
    { key: 'severity', header: 'Severity', sortValue: (r) => ['low', 'medium', 'high', 'critical'].indexOf(r.severity),
      cell: (r) => <Badge variant="outline" className={cn('capitalize', SEVERITY[r.severity])}>{r.severity}</Badge> },
    { key: 'title', header: 'Exception', sortValue: (r) => r.title, className: 'whitespace-normal max-w-md',
      cell: (r) => (
        <div>
          <p className="text-sm font-medium">{r.title}</p>
          <p className="text-xs text-muted-foreground">{r.area} · {r.label}</p>
        </div>
      ) },
    { key: 'amount', header: 'Amount', align: 'right', sortValue: (r) => r.amountPaise ?? 0,
      cell: (r) => (r.amountPaise == null ? <span className="text-muted-foreground">—</span> : <Money value={r.amountPaise} whole />) },
    { key: 'owner', header: 'Owner', sortValue: (r) => r.ownerName ?? '',
      cell: (r) => (r.ownerName ? <span className="text-sm">{r.ownerName}</span> : <span className="text-sm text-amber-700">Unassigned</span>) },
    { key: 'due', header: 'Deal with by', sortValue: (r) => r.dueAt ?? '',
      cell: (r) => (
        <span className={cn('text-sm', r.overdue && 'font-medium text-red-700 dark:text-red-400')}>
          {day(r.dueAt)}{r.escalationLevel >= 2 ? ' · escalated' : r.overdue ? ' · late' : ''}
        </span>
      ) },
    { key: 'status', header: 'Status', sortValue: (r) => r.status,
      cell: (r) => <span className="text-sm">{STATUS_LABEL[r.status]}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Exceptions"
        description="What needs dealing with: each found by the scheduler, given an owner and a date, escalated when the date passes, and closed with what was done."
        actions={
          <Button variant="outline" size="sm" className="gap-1.5" onClick={scan} disabled={scanning}>
            {scanning ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Check now
          </Button>
        }
      />
      <AsyncPage state={state}>
        {(d) => (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-4">
              {[
                ['Open', d.summary.active, ''],
                ['Critical', d.summary.critical, d.summary.critical ? 'text-red-700 dark:text-red-400' : ''],
                ['High', d.summary.high, d.summary.high ? 'text-orange-700 dark:text-orange-400' : ''],
                ['Closed', d.summary.closed, ''],
              ].map(([label, n, tone]) => (
                <Card key={label as string} className="p-4">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
                  <p className={cn('text-2xl font-semibold', tone as string)}>{n}</p>
                </Card>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select className="h-8 rounded-md border bg-background px-2 text-sm" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
                <option value="">Every kind</option>
                {Object.entries(EXCEPTION_KINDS).map(([k, v]) => <option key={k} value={k}>{v.area}: {v.label}</option>)}
              </select>
            </div>
            <DataTable
              rows={d.exceptions}
              columns={columns}
              getRowId={(r) => r.id}
              onRowClick={(r) => setOpenId(r.id)}
              tabs={[
                { value: 'active', label: 'Open', count: d.summary.active },
                { value: 'mine', label: 'Mine' },
                { value: 'closed', label: 'Closed', count: d.summary.closed },
              ]}
              activeTab={view}
              onTabChange={(v) => setView(v as typeof view)}
              searchPlaceholder="Search exceptions…"
              emptyMessage={view === 'closed' ? 'Nothing closed yet.' : 'Nothing needs dealing with. The scheduler checks every ten minutes.'}
            />
            <ExceptionDialog id={openId} list={d} onClose={() => setOpenId(null)} onChanged={() => state.refetch()} />
          </div>
        )}
      </AsyncPage>
    </>
  );
}

function ExceptionDialog({ id, list, onClose, onChanged }: { id: string | null; list: ListResponse; onClose: () => void; onChanged: () => void }) {
  const state = useApi<Detail | null>(() => (id ? api.get(`/api/exceptions/${id}`) : Promise.resolve(null)), [id]);
  const [note, setNote] = useState('');
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState(false);
  const x = state.data?.exception;
  const mine = x?.ownerId === list.me;
  const closed = x?.status === 'resolved' || x?.status === 'waived';

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!id) return;
    setBusy(true);
    try {
      await api.post(`/api/exceptions/${id}`, { action, note: note || null, ...extra });
      setNote('');
      await state.refetch();
      onChanged();
      toast.success({ assign: 'Handed on', start: 'Taken on', note: 'Note added', resolve: 'Resolved', waive: 'Waived', reopen: 'Reopened' }[action] ?? 'Done');
    } catch (e) {
      toast.error('Not done', { description: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!id} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        {x ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-start gap-2 pr-6">
                <AlertOctagon className="mt-0.5 size-5 shrink-0 text-amber-600" /> {x.title}
              </DialogTitle>
              <DialogDescription>{x.detail}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline" className={cn('capitalize', SEVERITY[x.severity])}>{x.severity}</Badge>
              <Badge variant="outline">{STATUS_LABEL[x.status]}</Badge>
              <Badge variant="outline">Owner: {x.ownerName ?? 'nobody'}</Badge>
              <Badge variant="outline" className={x.overdue ? 'text-red-700' : ''}>By {day(x.dueAt)}</Badge>
              {x.href && (
                <Link href={x.href} className="inline-flex items-center gap-1 text-primary hover:underline">
                  Open the record <ArrowUpRight className="size-3" />
                </Link>
              )}
            </div>
            {x.resolution && <p className="text-sm"><span className="font-medium">{x.status === 'waived' ? 'Accepted because: ' : 'Resolution: '}</span>{x.resolution}</p>}

            <div className="max-h-56 space-y-2 overflow-y-auto rounded-md border p-3">
              {state.data!.events.map((e) => (
                <div key={e.id} className="text-sm">
                  <span className="text-xs text-muted-foreground">{at(e.at)} · {e.by} · </span>
                  <span className="font-medium capitalize">{e.action}</span>
                  {e.note && <span className="text-muted-foreground"> — {e.note}</span>}
                </div>
              ))}
            </div>

            {(mine || list.canManage) && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="exc-note">Note, resolution or reason</Label>
                  <Textarea id="exc-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)}
                    placeholder="What was done, or why it is accepted" />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {!closed && x.status === 'open' && <Button size="sm" variant="outline" disabled={busy} onClick={() => act('start')}>Take it on</Button>}
                  <Button size="sm" variant="outline" disabled={busy || !note.trim()} onClick={() => act('note')}>Add note</Button>
                  {!closed && <Button size="sm" disabled={busy || note.trim().length < 5} onClick={() => act('resolve')}>Resolve</Button>}
                  {!closed && list.canManage && <Button size="sm" variant="outline" disabled={busy || note.trim().length < 5} onClick={() => act('waive')}>Waive</Button>}
                  {closed && x.stillPresent && <Button size="sm" variant="outline" disabled={busy} onClick={() => act('reopen')}>Reopen</Button>}
                  {list.canManage && !closed && (
                    <div className="ml-auto flex items-center gap-1.5">
                      <select className="h-8 rounded-md border bg-background px-2 text-sm" value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Give to">
                        <option value="">Give to…</option>
                        {list.users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}
                      </select>
                      <Button size="sm" variant="outline" disabled={busy || !owner} onClick={() => act('assign', { ownerUserId: owner })}>Assign</Button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        ) : state.error ? (
          <div className="p-6 text-sm text-muted-foreground">
            <DialogTitle className="sr-only">Exception</DialogTitle>
            {state.error}
          </div>
        ) : (
          <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <DialogTitle className="sr-only">Exception</DialogTitle>
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
