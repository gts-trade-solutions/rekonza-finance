'use client';

// Projects: work done for customers, with the hours logged, what is still
// unbilled, and what each one has made after the cost of the time and the
// expenses booked to it.

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FolderKanban, Plus, Timer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { StatTile } from '@/components/shared/stat-tile';
import { AsyncPage } from '@/components/shared/async-state';
import { EmptyState } from '@/components/shared/empty-state';
import { ProjectDialog, METHOD_LABEL } from '@/components/projects/project-dialog';
import { hoursText } from '@/components/projects/log-time-dialog';
import { projects, type ProjectRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { formatINRCompact } from '@/lib/money';

const STATUSES = ['active', 'completed', 'archived', 'all'] as const;

export default function ProjectsPage() {
  const router = useRouter();
  const canCreate = usePermission('projects', 'create');
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('active');
  const [open, setOpen] = useState(false);
  const state = useApi(() => projects.list({ status }), [status]);

  const columns: Column<ProjectRow>[] = [
    {
      key: 'name', header: 'Project', sortValue: (r) => r.name,
      cell: (r) => (
        <div>
          <p className="font-medium">{r.name}</p>
          <p className="text-xs text-muted-foreground">{r.customerName}{r.code ? ` · ${r.code}` : ''}</p>
        </div>
      ),
    },
    { key: 'method', header: 'Billing', sortValue: (r) => r.billingMethod, cell: (r) => <span className="text-xs">{METHOD_LABEL[r.billingMethod]}</span> },
    {
      key: 'hours', header: 'Logged', align: 'right', sortValue: (r) => r.loggedMinutes,
      cell: (r) => (
        <span className="tabular-nums">
          {hoursText(r.loggedMinutes)}
          {r.budgetHours ? <span className={r.loggedMinutes / 60 > r.budgetHours ? 'text-destructive' : 'text-muted-foreground'}> / {r.budgetHours}</span> : null}
        </span>
      ),
    },
    { key: 'unbilled', header: 'Unbilled hours', align: 'right', sortValue: (r) => r.unbilledMinutes, cell: (r) => <span className="tabular-nums">{r.unbilledMinutes ? hoursText(r.unbilledMinutes) : '—'}</span> },
    { key: 'billed', header: 'Billed', align: 'right', sortValue: (r) => r.billedPaise, cell: (r) => <Money value={r.billedPaise} showZero={false} /> },
    { key: 'profit', header: 'Profit', align: 'right', sortValue: (r) => r.profitPaise, cell: (r) => <Money value={r.profitPaise} className={r.profitPaise < 0 ? 'text-destructive' : undefined} /> },
    { key: 'status', header: 'Status', sortValue: (r) => r.status, cell: (r) => <Badge variant={r.status === 'active' ? 'secondary' : 'outline'} className="text-[10px] capitalize">{r.status}</Badge> },
  ];

  return (
    <>
      <PageHeader
        title="Projects"
        description="Work done for customers, the time logged to it, and billing it. A project's profit is what was billed less the cost of the time and the expenses booked to it."
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" asChild className="gap-1.5"><Link href="/projects/timesheet"><Timer className="size-4" /> Timesheet</Link></Button>
            {canCreate && <Button size="sm" onClick={() => setOpen(true)} className="gap-1.5"><Plus className="size-4" /> New project</Button>}
          </div>
        }
      />
      <div className="flex gap-1" role="tablist" aria-label="Which projects">
        {STATUSES.map((s) => (
          <Button key={s} size="sm" variant={status === s ? 'secondary' : 'ghost'} onClick={() => setStatus(s)} className="capitalize">{s}</Button>
        ))}
      </div>
      <AsyncPage state={state}>
        {(d) => (
          <>
            <div className="grid gap-3 sm:grid-cols-4">
              <StatTile label="Projects" value={String(d.projects.length)} />
              <StatTile label="Hours logged" value={hoursText(d.projects.reduce((t, p) => t + p.loggedMinutes, 0))} />
              <StatTile label="Unbilled hours" value={hoursText(d.projects.reduce((t, p) => t + p.unbilledMinutes, 0))} tone="warning" />
              <StatTile label="Billed" value={formatINRCompact(d.projects.reduce((t, p) => t + p.billedPaise, 0))} tone="positive" />
            </div>
            {d.projects.length ? (
              <DataTable rows={d.projects} columns={columns} getRowId={(r) => r.id} onRowClick={(r) => router.push(`/projects/${r.id}`)} searchPlaceholder="Search projects or customers…" />
            ) : (
              <EmptyState icon={FolderKanban} title="No projects here" description="A project gathers the time and expenses of a piece of work for one customer, and bills them."
                action={canCreate ? <Button size="sm" onClick={() => setOpen(true)}><Plus className="size-4" /> New project</Button> : undefined} />
            )}
          </>
        )}
      </AsyncPage>
      <ProjectDialog open={open} onOpenChange={setOpen} onSaved={(id) => router.push(`/projects/${id}`)} />
    </>
  );
}
