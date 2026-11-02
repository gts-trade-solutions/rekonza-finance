'use client';

// The timesheet: time logged to projects, a week at a time, with a total per
// day. Without the right to manage projects a person sees and logs their own.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage } from '@/components/shared/async-state';
import { LogTimeDialog, hoursText } from '@/components/projects/log-time-dialog';
import { ApprovalsPanel, TimerCard } from '@/components/projects/timer';
import { timeEntries } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { today } from '@/lib/selectors';

const monday = (d: string) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
const plus = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const label = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' });

export default function TimesheetPage() {
  const canLog = usePermission('projects', 'create');
  const [week, setWeek] = useState(() => monday(today()));
  const [open, setOpen] = useState(false);
  const state = useApi(() => timeEntries.list({ from: week, to: plus(week, 6) }), [week]);
  const remove = useApiAction(timeEntries.remove);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => plus(week, i)), [week]);
  const [showApprovals, setShowApprovals] = useState(false);

  return (
    <>
      <PageHeader
        title="Timesheet"
        description="Time logged to projects, a week at a time. Billable time waits on its project until it is billed."
        actions={canLog ? <Button size="sm" onClick={() => setOpen(true)} className="gap-1.5"><Plus className="size-4" /> Log time</Button> : undefined}
      />
      {canLog && <TimerCard onLogged={() => state.refetch()} />}
      {state.data?.approvalOn && state.data.canApprove && (
        <div className="space-y-2">
          <Button size="sm" variant={showApprovals ? 'secondary' : 'outline'} onClick={() => setShowApprovals((v) => !v)}>{showApprovals ? 'Hide approvals' : 'Time waiting for my approval'}</Button>
          {showApprovals && <ApprovalsPanel onDecided={() => state.refetch()} />}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button size="icon-sm" variant="outline" aria-label="Previous week" onClick={() => setWeek(plus(week, -7))}><ChevronLeft className="size-4" /></Button>
        <span className="text-sm font-medium">{label(week)} – {label(plus(week, 6))}</span>
        <Button size="icon-sm" variant="outline" aria-label="Next week" onClick={() => setWeek(plus(week, 7))}><ChevronRight className="size-4" /></Button>
        {week !== monday(today()) && <Button size="sm" variant="ghost" onClick={() => setWeek(monday(today()))}>This week</Button>}
      </div>
      <AsyncPage state={state}>
        {(d) => {
          const total = d.entries.reduce((t, e) => t + e.minutes, 0);
          return (
            <>
              <p className="text-sm text-muted-foreground">
                {hoursText(total)} hours this week{d.ownOnly ? ', yours' : ', everyone\'s'} · {hoursText(d.entries.filter((e) => e.billable).reduce((t, e) => t + e.minutes, 0))} billable
              </p>
              <div className="grid gap-3 lg:grid-cols-7">
                {days.map((day) => {
                  const list = d.entries.filter((e) => e.date === day);
                  return (
                    <Card key={day} className="p-3" data-slot="timesheet-day">
                      <div className="mb-2 flex items-baseline justify-between">
                        <p className="text-xs font-semibold">{label(day)}</p>
                        <p className="text-xs tabular-nums text-muted-foreground">{list.length ? hoursText(list.reduce((t, e) => t + e.minutes, 0)) : ''}</p>
                      </div>
                      <div className="space-y-2">
                        {list.map((e) => (
                          <div key={e.id} className="rounded-[3px] border p-2 text-xs">
                            <div className="flex items-start justify-between gap-1">
                              <Link href={`/projects/${e.projectId}`} className="font-medium hover:underline">{e.projectName}</Link>
                              <span className="tabular-nums">{hoursText(e.minutes)}</span>
                            </div>
                            <p className="text-muted-foreground">{[e.taskName, d.ownOnly ? null : e.userName].filter(Boolean).join(' · ')}</p>
                            {e.notes && <p className="mt-0.5">{e.notes}</p>}
                            {e.approvalStatus === 'pending' && <Badge variant="outline" className="mt-1 border-amber-500/40 text-[9px] text-amber-700 dark:text-amber-300">Waiting for approval</Badge>}
                            {e.approvalStatus === 'approved' && <Badge variant="outline" className="mt-1 text-[9px]" title={e.approvedBy ? `By ${e.approvedBy}` : undefined}>Approved</Badge>}
                            {e.approvalStatus === 'rejected' && <p className="mt-1 text-[10px] text-destructive">Turned back{e.approvedBy ? ` by ${e.approvedBy}` : ''}: {e.approvalNote}. Remove it and log it again, corrected.</p>}
                            <div className="mt-1 flex items-center justify-between">
                              {e.invoiceId ? <Badge variant="outline" className="text-[9px]">Billed {e.invoiceNumber}</Badge>
                                : e.billable ? <Badge variant="outline" className="text-[9px]">Unbilled</Badge> : <span className="text-muted-foreground">Not billable</span>}
                              {!e.invoiceId && canLog && (
                                <Button size="icon-sm" variant="ghost" aria-label="Remove entry"
                                  onClick={async () => { if (await remove.run(e.id)) { toast.info('Entry removed'); state.refetch(); } else toast.error(remove.error ?? 'Not removed'); }}>
                                  <Trash2 className="size-3.5" />
                                </Button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </Card>
                  );
                })}
              </div>
            </>
          );
        }}
      </AsyncPage>
      <LogTimeDialog open={open} onOpenChange={setOpen} onLogged={() => state.refetch()} />
    </>
  );
}
