'use client';

// The audit trail.
//
// Rows here are a by-product of how the system works rather than a feature
// somebody switched on: the ledger only ever adds entries, never edits or
// deletes them, and every business action writes its own record as it happens.
// There is no endpoint that can write one directly and none at all that can
// remove one — which is what MCA Rule 11(g) actually requires. Edits to masters
// carry an edit log: each field that changed, from what, to what (Rule 3(1)).

import { useState } from 'react';
import { Lock, ShieldCheck } from 'lucide-react';
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
          {new Date(r.at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
        </p>
        <p className="text-xs text-muted-foreground">
          {new Date(r.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </p>
      </div>
    ),
  },
  {
    key: 'user', header: 'Who', sortValue: (r) => r.actorName,
    cell: (r) => <span className="font-medium">{r.actorName}</span>,
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

/** A before or after value, short enough for one line. */
function shown(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(empty)';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

export default function AuditTrailPage() {
  const [entity, setEntity] = useState('all');
  const state = useApi<AuditResponse>(() => audit.list({ targetType: entity, limit: 500 }), [entity]);

  return (
    <>
      <PageHeader
        title="Audit trail"
        description="Every create, change and void — who did it, when, and what changed."
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

      <AsyncPage state={state}>
        {(d) =>
          d.events.length === 0 && entity === 'all' ? (
            <EmptyState
              icon={ShieldCheck}
              title="No activity recorded yet"
              description="Actions you take will appear here immediately."
            />
          ) : (
            <DataTable
              dateFilter={{ getDate: (r) => r.at.slice(0, 10) }}
              rows={d.events}
              columns={columns}
              getRowId={(r) => r.id}
              initialSort={{ key: 'at', dir: 'desc' }}
              searchPlaceholder="Search user, record or detail…"
              emptyMessage="Nothing recorded for this record type."
              toolbar={
                <Select value={entity} onValueChange={setEntity}>
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
          )
        }
      </AsyncPage>
    </>
  );
}
