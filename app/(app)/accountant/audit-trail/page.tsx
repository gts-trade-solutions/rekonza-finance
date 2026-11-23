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
import { Download, Lock, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ExportDialog } from '@/components/shared/export-dialog';
import { usePermission } from '@/lib/store/hooks';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { audit, type AuditEventRow, type AuditResponse } from '@/lib/api/client';
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
const ACTIONS = ['create', 'update', 'delete', 'approve', 'void', 'send', 'match', 'import', 'export', 'login'];

export default function AuditTrailPage() {
  const canExport = usePermission('accountant', 'export');
  const [entity, setEntity] = useState('all');
  const [action, setAction] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [exporting, setExporting] = useState(false);
  // The search runs on the server, over every row, a moment after typing stops.
  useEffect(() => {
    const t = window.setTimeout(() => { setSearch(typed.trim()); setLimit(PAGE); }, 350);
    return () => window.clearTimeout(t);
  }, [typed]);
  const filters = { targetType: entity, action, from: from || undefined, to: to || undefined, search: search || undefined };
  const state = useApi<AuditResponse>(() => audit.list({ ...filters, limit }), [entity, action, from, to, search, limit]);
  const reset = () => setLimit(PAGE);

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
      <ExportDialog
        open={exporting} onOpenChange={setExporting} title="Export Audit Trail" noun="Events" filename="audit-trail"
        modules={[{
          value: 'events', label: 'Audit trail events',
          sheets: async (o) => {
            const r = await audit.exportRows({ targetType: entity, action, search: search || undefined, from: o.from ?? (from || undefined), to: o.to ?? (to || undefined), pii: o.pii });
            if (r.truncated) toast.info('The first 100,000 events are in the file. Narrow the dates for the rest.');
            return [{ name: 'Audit trail', rows: [r.header, ...r.rows] }];
          },
        }]}
      />

      <Card className="flex items-start gap-3 border-primary/30 bg-primary/5 p-4">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="text-sm">
          <p className="font-medium">Why this can&apos;t be switched off</p>
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
                title="The app never edits these rows, but the database does not yet refuse a direct edit. Run npm run db:protect."
              >
                Database lock not installed
              </Badge>
            ))}
          </div>
        </div>
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
        <label className="min-w-56 flex-1 space-y-1 text-[11px] font-medium text-muted-foreground">
          <span className="block">Search every event</span>
          <Input value={typed} onChange={(ev) => setTyped(ev.target.value)} placeholder="User, record, detail, reason or IP" className="h-9" data-slot="audit-search" />
        </label>
        {(from || to || action !== 'all' || typed || entity !== 'all') && (
          <Button size="sm" variant="ghost" onClick={() => { setFrom(''); setTo(''); setAction('all'); setTyped(''); setEntity('all'); reset(); }}>Clear</Button>
        )}
      </Card>

      <AsyncPage state={state}>
        {(d) =>
          d.events.length === 0 && entity === 'all' && action === 'all' && !from && !to && !search ? (
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
              toolbar={
                <Select value={entity} onValueChange={(v) => { setEntity(v); reset(); }}>
                  <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All record types</SelectItem>
                    {d.targetTypes.map((t) => (
                      <SelectItem key={t.value} value={t.value} className="capitalize">
                        {t.value.replace(/[_-]/g, ' ')} ({t.count})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
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
