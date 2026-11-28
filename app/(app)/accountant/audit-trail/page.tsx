'use client';

// The audit trail.
//
// Rows here are a by-product of how the system works rather than a feature
// somebody switched on: the ledger only ever adds entries, never edits or
// deletes them, and every business action writes its own record as it happens.
// There is no endpoint that can write one directly and none at all that can
// remove one — which is what MCA Rule 11(g) actually requires. Edits to masters
// carry an edit log: each field that changed, from what, to what (Rule 3(1)).

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, Fingerprint, Loader2, Lock, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AuditExportDialog } from '@/components/audit/audit-export';
import { usePermission } from '@/lib/store/hooks';
import { useAppStore } from '@/lib/store';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { auditTrail, type AuditChainStatus, type AuditEventRow, type AuditListResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

const ACTION_TONE: Record<string, string> = {
  create: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300',
  update: 'border-blue-500/40 text-blue-700 dark:text-blue-300',
  approve: 'border-blue-500/40 text-blue-700 dark:text-blue-300',
  send: 'border-blue-500/40 text-blue-700 dark:text-blue-300',
  match: 'border-blue-500/40 text-blue-700 dark:text-blue-300',
  import: 'border-blue-500/40 text-blue-700 dark:text-blue-300',
  export: 'border-blue-500/40 text-blue-700 dark:text-blue-300',
  void: 'border-red-500/40 text-red-700 dark:text-red-300',
  login: 'border-muted-foreground/30 text-muted-foreground',
};

const columns: Column<AuditEventRow>[] = [
  {
    key: 'at', header: 'When', sortValue: (r) => r.at,
    cell: (r) => (
      <div>
        <p className="text-sm">
          {new Date(r.at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}
        </p>
        <p className="text-xs text-muted-foreground">
          {new Date(r.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kolkata' })} IST
        </p>
      </div>
    ),
  },
  {
    key: 'user', header: 'Who', sortValue: (r) => r.actorName,
    cell: (r) => (
      <div>
        <p className="font-medium">{r.actorName}</p>
        {r.ip && <p className="font-mono text-[11px] text-muted-foreground" title="The address the change came from">{r.ip}</p>}
      </div>
    ),
  },
  {
    key: 'action', header: 'Action', sortValue: (r) => r.action,
    cell: (r) => (
      <Badge variant="outline" className={`text-[10px] capitalize ${ACTION_TONE[r.action] ?? ''}`}>
        {r.action}
      </Badge>
    ),
  },
  {
    key: 'entity', header: 'Record', sortValue: (r) => r.targetType,
    cell: (r) => (
      <div>
        <p className="text-sm font-medium">{r.targetLabel}</p>
        <p className="text-xs capitalize text-muted-foreground">{r.targetType.replace(/[_-]/g, ' ')}</p>
      </div>
    ),
  },
  {
    key: 'detail', header: 'Detail', sortValue: (r) => r.detail,
    cell: (r) => (
      <div className="space-y-1">
        <span className="text-sm text-muted-foreground">{r.detail}</span>
        {r.reason && (
          <p className="text-xs"><span className="font-medium">Why:</span> {r.reason}</p>
        )}
        {r.changes && (
          <ul className="space-y-0.5 text-xs">
            {Object.entries(r.changes).map(([field, c]) => (
              <li key={field} className="leading-snug">
                <span className="font-mono text-muted-foreground">{field.replace(/_/g, ' ')}</span>{' '}
                <span className="text-red-700 line-through decoration-red-400/60 dark:text-red-300">{shown(c.from)}</span>
                {' → '}
                <span className="text-emerald-700 dark:text-emerald-300">{shown(c.to)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    ),
    className: 'whitespace-normal max-w-md',
  },
];

/** A before or after value, whole: an auditor reads the full old and new value (very long ones are in the export). */
function shown(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(empty)';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 400 ? `${s.slice(0, 397)}…` : s;
}

const PAGE = 300;
const ACTIONS = ['create', 'update', 'delete', 'approve', 'void', 'send', 'match', 'import', 'export', 'login', 'verify'];

export default function AuditTrailPage() {
  const canExport = usePermission('accountant', 'export');
  const [entity, setEntity] = useState('all');
  const [action, setAction] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const [actor, setActor] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [exporting, setExporting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState<AuditChainStatus | null>(null);
  const me = useAppStore((st) => st.users.find((u) => u.id === st.session?.userId)?.name ?? 'me');
  // The search runs on the server, over every row, a moment after typing stops.
  useEffect(() => {
    const t = window.setTimeout(() => { setSearch(typed.trim()); setLimit(PAGE); }, 350);
    return () => window.clearTimeout(t);
  }, [typed]);
  const filters = { targetType: entity, action, actorUserId: actor || undefined, from: from || undefined, to: to || undefined, search: search || undefined };
  const state = useApi<AuditListResponse>(() => auditTrail.list({ ...filters, limit }), [entity, action, actor, from, to, search, limit]);
  const reset = () => setLimit(PAGE);
  const verify = async () => {
    setVerifying(true);
    try {
      const r = await auditTrail.verify();
      setVerified(r);
      if (r.ok) toast.success('The audit trail is intact', { description: `${r.checked.toLocaleString('en-IN')} events checked; none changed or removed.` });
      else toast.error('The audit trail has been tampered with', { description: r.problems[0]?.detail });
      state.refetch();
    } catch (e) {
      toast.error('Not verified', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Audit trail"
        description="Every create, change and void — who did it, when, and what changed."
        actions={canExport && (
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setExporting(true)} data-slot="audit-export">
            <Download className="size-3.5" /> Export
          </Button>
        )}
      />
      <AuditExportDialog open={exporting} onOpenChange={setExporting} filters={filters} userName={me} />

      <Card className="flex items-start gap-3 border-primary/30 bg-primary/5 p-4">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">Why this can&apos;t be switched off</p>
          <p className="mt-1 text-xs font-medium" data-slot="audit-cannot-disable">
            The audit trail cannot be switched off, and no one — not an admin, not the auditor, not Rekonza — can edit or delete an entry in it.
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Indian companies keeping books electronically must maintain an edit log recording every change to the
            accounts, keep it for eight financial years, and must not be able to disable it. Your auditor has to
            confirm it was running all year. Because our ledger only ever adds entries and never edits or deletes
            them, this record is a by-product of how the system works rather than a feature someone could turn off.
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Badge variant="outline" className="gap-1 border-emerald-500/40 text-[10px]">
              <Lock className="size-2.5" /> Append-only
            </Badge>
            <Badge variant="outline" className="border-emerald-500/40 text-[10px]">8-year retention</Badge>
            <Badge variant="outline" className="border-emerald-500/40 text-[10px]">No disable switch</Badge>
            {state.data && (
              <Badge variant="outline" className="border-emerald-500/40 text-[10px]">
                {state.data.total} events recorded
              </Badge>
            )}
            {state.data && (state.data.databaseProtected ? (
              <Badge variant="outline" className="gap-1 border-emerald-500/40 text-[10px]">
                <Lock className="size-2.5" /> Locked in the database
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="border-amber-500/40 text-[10px] text-amber-700 dark:text-amber-300"
                title="The hash chain still detects any direct change. The server's administrator installs the lock with root access to MySQL."
                data-slot="audit-db-lock"
              >
                Database lock not yet installed
              </Badge>
            ))}
          </div>
          {state.data && !state.data.databaseProtected && (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground" data-slot="audit-db-lock-note">
              <span className="font-medium text-foreground">About the database lock.</span> Rekonza itself never edits or deletes an audit row,
              and the hash chain below (Verify integrity) detects any row changed or removed directly in the database, naming the row.
              The lock goes one step further: MySQL itself refuses such a change. It is a set of database triggers
              (db/protect/tamper_proof_trail.sql, run with npm run db:protect) that only the server&apos;s administrator can install,
              because it needs root access to MySQL on the server. Until it is installed, rely on Verify integrity and note the chain head in your working papers.
            </p>
          )}
        </div>
      </Card>

      <Card className="flex flex-wrap items-start gap-3 p-4" data-slot="audit-integrity">
        <Fingerprint className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">Integrity check</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Every event is sealed into a hash chain: each one&apos;s SHA-256 covers its own content and the event before it. If anyone changed or
            removed an event directly in the database, Verify integrity shows exactly which one. Note the chain head below in your working papers;
            if a later check shows a different head with fewer events, events were cut from the end.
          </p>
          {state.data && (
            <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground" data-slot="audit-chain-head">
              Chain head: {verified?.headHash ?? state.data.chain.headHash} · {(verified?.headSeq ?? state.data.chain.headSeq).toLocaleString('en-IN')} events sealed
              {state.data.chain.verifiedAt && !verified ? ` · last verified ${new Date(state.data.chain.verifiedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST (${state.data.chain.verifiedOk ? 'intact' : 'problems found'})` : ''}
            </p>
          )}
          {verified && (verified.ok ? (
            <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300" data-slot="audit-verify-ok">
              <CheckCircle2 className="size-3.5" /> Intact: all {verified.checked.toLocaleString('en-IN')} sealed events match their seals, and the chain is unbroken. Checked {new Date(verified.verifiedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST.
            </p>
          ) : (
            <div className="mt-2 space-y-1 text-xs text-destructive" data-slot="audit-verify-problems">
              <p className="flex items-center gap-1.5 font-medium"><AlertTriangle className="size-3.5" /> Tampering found: {verified.problems.length} problem{verified.problems.length === 1 ? '' : 's'}.</p>
              <ul className="list-disc pl-5">{verified.problems.slice(0, 20).map((p) => <li key={`${p.seq}-${p.kind}-${p.auditId}`}>{p.detail}</li>)}</ul>
            </div>
          ))}
        </div>
        <Button size="sm" variant="outline" className="gap-1.5" disabled={verifying} onClick={() => void verify()} data-slot="audit-verify">
          {verifying ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />} Verify integrity
        </Button>
      </Card>

      <Card className="flex flex-wrap items-end gap-3 p-3" data-slot="audit-filters">
        <label className="space-y-1 text-[11px] font-medium text-muted-foreground">
          <span className="block">From (IST)</span>
          <Input type="date" value={from} onChange={(ev) => { setFrom(ev.target.value); reset(); }} className="h-9 w-40" aria-label="From" />
        </label>
        <label className="space-y-1 text-[11px] font-medium text-muted-foreground">
          <span className="block">To (IST)</span>
          <Input type="date" value={to} onChange={(ev) => { setTo(ev.target.value); reset(); }} className="h-9 w-40" aria-label="To" />
        </label>
        <label className="space-y-1 text-[11px] font-medium text-muted-foreground">
          <span className="block">Action</span>
          <select value={action} onChange={(ev) => { setAction(ev.target.value); reset(); }} className="h-9 w-36 rounded-md border bg-background px-2 text-sm capitalize" aria-label="Action">
            <option value="all">All actions</option>
            {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-[11px] font-medium text-muted-foreground">
          <span className="block">User</span>
          <select value={actor} onChange={(ev) => { setActor(ev.target.value); reset(); }} className="h-9 w-44 rounded-md border bg-background px-2 text-sm" aria-label="User" data-slot="audit-user">
            <option value="">Everyone</option>
            {(state.data?.actors ?? []).map((a) => <option key={a.id} value={a.id}>{a.name} ({a.count})</option>)}
          </select>
        </label>
        <label className="space-y-1 text-[11px] font-medium text-muted-foreground">
          <span className="block">Record type</span>
          <select value={entity} onChange={(ev) => { setEntity(ev.target.value); reset(); }} className="h-9 w-48 rounded-md border bg-background px-2 text-sm capitalize" aria-label="Record type" data-slot="audit-type">
            <option value="all">All record types</option>
            {(state.data?.targetTypes ?? []).map((t) => <option key={t.value} value={t.value}>{t.value.replace(/[_-]/g, ' ')} ({t.count})</option>)}
          </select>
        </label>
        <label className="min-w-56 flex-1 space-y-1 text-[11px] font-medium text-muted-foreground">
          <span className="block">Search every event</span>
          <Input value={typed} onChange={(ev) => setTyped(ev.target.value)} placeholder="User, record, detail, reason or IP" className="h-9" data-slot="audit-search" />
        </label>
        {(from || to || action !== 'all' || typed || entity !== 'all' || actor) && (
          <Button size="sm" variant="ghost" onClick={() => { setFrom(''); setTo(''); setAction('all'); setTyped(''); setEntity('all'); setActor(''); reset(); }}>Clear</Button>
        )}
      </Card>

      <AsyncPage state={state}>
        {(d) =>
          d.events.length === 0 && entity === 'all' && action === 'all' && !from && !to && !search && !actor ? (
            <EmptyState
              icon={ShieldCheck}
              title="No activity recorded yet"
              description="Actions you take will appear here immediately."
            />
          ) : (
            <>
            <p className="text-[12px] text-muted-foreground" data-slot="audit-count">
              Showing {d.events.length.toLocaleString('en-IN')} of {d.total.toLocaleString('en-IN')} event{d.total === 1 ? '' : 's'}{d.total > d.events.length ? ' (newest first)' : ''}.
            </p>
            <DataTable
              rows={d.events}
              columns={columns}
              getRowId={(r) => r.id}
              initialSort={{ key: 'at', dir: 'desc' }}
              searchPlaceholder="Search these rows…"
              emptyMessage="Nothing recorded for these filters."
            />
            {d.total > d.events.length && (
              <div className="flex justify-center">
                <Button variant="outline" size="sm" onClick={() => setLimit((n) => Math.min(n + PAGE, 1000))} disabled={limit >= 1000} data-slot="audit-more">
                  {limit >= 1000 ? 'Narrow the filters, or export, for the rest' : `Load ${Math.min(PAGE, d.total - d.events.length)} more`}
                </Button>
              </div>
            )}
            </>
          )
        }
      </AsyncPage>
    </>
  );
}
