'use client';

// One project: hours against budget, what is unbilled, what it has billed and
// made, its time log, its expenses and its invoices. "Bill" raises an invoice
// for what is unbilled (services/projects.ts).

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Plus, ReceiptText, Timer, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { StatTile } from '@/components/shared/stat-tile';
import { StatusBadge } from '@/components/shared/status-badge';
import { AsyncPage } from '@/components/shared/async-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { ProjectDialog, METHOD_LABEL } from '@/components/projects/project-dialog';
import { CustomFieldsPanel } from '@/components/shared/custom-fields-panel';
import { ActivityPanel } from '@/components/shared/activity-panel';
import { LogTimeDialog, hoursText } from '@/components/projects/log-time-dialog';
import { projects, timeEntries, type ProjectDetail, type TimeEntryRow } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { formatINR, formatINRCompact } from '@/lib/money';
import { today } from '@/lib/selectors';

const short = (d: string) => new Date(d).toLocaleDateString('en-IN');
const plusDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const state = useApi<ProjectDetail>(() => projects.get(id), [id]);
  const canLog = usePermission('projects', 'create');
  const canEdit = usePermission('projects', 'edit');
  const canBill = usePermission('sales', 'create');
  const [editing, setEditing] = useState(false);
  const [logging, setLogging] = useState(false);
  const [billing, setBilling] = useState(false);
  const [bill, setBill] = useState({ date: today(), dueDate: plusDays(today(), 15), through: today(), includeExpenses: true, fixedPaise: 0, issue: false });
  const billAction = useApiAction(projects.bill);
  const remove = useApiAction(timeEntries.remove);
  const status = useApiAction(projects.setStatus);

  const timeCols: Column<TimeEntryRow>[] = [
    { key: 'date', header: 'Date', sortValue: (r) => r.date, cell: (r) => short(r.date) },
    { key: 'who', header: 'Who', sortValue: (r) => r.userName, cell: (r) => r.userName },
    { key: 'task', header: 'Task', sortValue: (r) => r.taskName ?? '', cell: (r) => r.taskName ?? '—' },
    { key: 'notes', header: 'Notes', sortValue: (r) => r.notes ?? '', cell: (r) => <span className="text-xs text-muted-foreground">{r.notes}</span> },
    { key: 'time', header: 'Time', align: 'right', sortValue: (r) => r.minutes, cell: (r) => <span className="tabular-nums">{hoursText(r.minutes)}</span> },
    {
      key: 'billed', header: 'Billing', sortValue: (r) => (r.invoiceId ? 2 : r.billable ? 1 : 0),
      cell: (r) => r.invoiceId
        ? <Link href={`/sales/invoices/${r.invoiceId}`} className="text-xs text-primary hover:underline">{r.invoiceNumber}</Link>
        : r.billable ? <Badge variant="outline" className="text-[10px]">Unbilled</Badge> : <span className="text-xs text-muted-foreground">Not billable</span>,
    },
    {
      key: 'x', header: '', sortValue: () => 0,
      cell: (r) => (!r.invoiceId && canLog ? (
        <Button size="icon-sm" variant="ghost" aria-label="Remove entry"
          onClick={async (e) => { e.stopPropagation(); if (await remove.run(r.id)) { toast.info('Entry removed'); state.refetch(); } else toast.error(remove.error ?? 'Not removed'); }}>
          <Trash2 className="size-4" />
        </Button>
      ) : null),
    },
  ];

  const doBill = async (d: ProjectDetail) => {
    const done = await billAction.run(id, {
      date: bill.date, dueDate: bill.dueDate, through: bill.through, includeExpenses: bill.includeExpenses,
      fixedPaise: d.unbilled.fixed ? bill.fixedPaise || undefined : undefined, status: bill.issue ? 'approved' : 'draft',
    });
    if (!done) { toast.error(billAction.error ?? 'Nothing was billed'); return; }
    toast.success(`Invoice ${done.number} raised`, { description: bill.issue ? 'Issued and posted.' : 'Saved as a draft to check before it is issued.' });
    router.push(`/sales/invoices/${done.invoiceId}`);
  };

  return (
    <AsyncPage state={state}>
      {(d) => {
        const p = d.project;
        const f = d.figures;
        const overBudget = p.budgetHours != null && f.loggedMinutes / 60 > p.budgetHours;
        return (
          <>
            <PageHeader
              title={p.name}
              description={`${p.customerName} · ${METHOD_LABEL[p.billingMethod]}${p.billingMethod === 'project_hours' ? ` at ${formatINR(p.ratePaise)} an hour` : p.billingMethod === 'fixed' ? `, ${formatINR(p.fixedAmountPaise)}` : ''} · ${p.status}`}
              actions={
                <>
                  {canEdit && <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Edit</Button>}
                  {canEdit && p.status === 'active' && (
                    <Button size="sm" variant="ghost" onClick={async () => { if (await status.run(id, 'completed')) state.refetch(); }}>Mark completed</Button>
                  )}
                  {canEdit && p.status !== 'active' && (
                    <Button size="sm" variant="ghost" onClick={async () => { if (await status.run(id, 'active')) state.refetch(); }}>Reopen</Button>
                  )}
                  {canLog && p.status === 'active' && <Button size="sm" variant="outline" onClick={() => setLogging(true)} className="gap-1.5"><Timer className="size-4" /> Log time</Button>}
                  {canBill && (
                    <Button size="sm" onClick={() => { setBill((b) => ({ ...b, fixedPaise: d.unbilled.fixed?.leftPaise ?? 0 })); setBilling(true); }} disabled={!d.unbilled.totalPaise} className="gap-1.5">
                      <ReceiptText className="size-4" /> Bill {d.unbilled.totalPaise ? formatINRCompact(d.unbilled.totalPaise) : ''}
                    </Button>
                  )}
                </>
              }
            />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <StatTile label="Hours logged" value={hoursText(f.loggedMinutes)} sub={p.budgetHours != null ? `of ${p.budgetHours} budgeted` : undefined} tone={overBudget ? 'danger' : 'default'} />
              <StatTile label="Unbilled" value={formatINRCompact(d.unbilled.totalPaise)} sub={f.unbilledMinutes ? `${hoursText(f.unbilledMinutes)} h` : undefined} tone={d.unbilled.totalPaise ? 'warning' : 'default'} />
              <StatTile label="Billed" value={formatINRCompact(f.billedPaise)} tone="positive" />
              <StatTile label="Cost" value={formatINRCompact(f.timeCostPaise + f.expenseCostPaise)} sub="time and expenses" />
              <StatTile label="Profit" value={formatINRCompact(f.profitPaise)} tone={f.profitPaise < 0 ? 'danger' : 'positive'} />
            </div>

            <Tabs defaultValue="time">
              <TabsList>
                <TabsTrigger value="time">Time ({d.entries.length})</TabsTrigger>
                <TabsTrigger value="unbilled">Unbilled</TabsTrigger>
                <TabsTrigger value="expenses">Expenses ({d.expenses.length})</TabsTrigger>
                <TabsTrigger value="invoices">Invoices ({d.invoices.length})</TabsTrigger>
                <TabsTrigger value="setup">Tasks &amp; people</TabsTrigger>
                <TabsTrigger value="activity">Comments</TabsTrigger>
              </TabsList>
              <TabsContent value="time" className="mt-4">
                <DataTable rows={d.entries} columns={timeCols} getRowId={(r) => r.id} searchable={false} emptyMessage="No time logged yet." />
              </TabsContent>
              <TabsContent value="unbilled" className="mt-4 space-y-3">
                {d.unbilled.fixed && (
                  <Card className="p-4 text-sm">
                    Fixed fee {formatINR(d.unbilled.fixed.feePaise)}: {formatINR(d.unbilled.fixed.billedPaise)} billed, <strong>{formatINR(d.unbilled.fixed.leftPaise)}</strong> left.
                  </Card>
                )}
                {d.unbilled.time.map((t, i) => (
                  <Card key={i} className="flex items-center justify-between p-4 text-sm">
                    <span>{t.label} · {hoursText(t.minutes)} h at {formatINR(t.ratePaise)} <span className="text-xs text-muted-foreground">({t.entries} entries)</span></span>
                    <Money value={t.amountPaise} className="font-medium" />
                  </Card>
                ))}
                {d.unbilled.expenses.map((x) => (
                  <Card key={x.id} className="flex items-center justify-between p-4 text-sm">
                    <span>Re-charge {x.number} · {x.notes ?? 'expense'} · {short(x.date)}</span>
                    <Money value={x.amountPaise} className="font-medium" />
                  </Card>
                ))}
                {!d.unbilled.totalPaise && <p className="text-sm text-muted-foreground">Nothing is waiting to be billed.</p>}
              </TabsContent>
              <TabsContent value="expenses" className="mt-4 space-y-2">
                {d.expenses.map((x) => (
                  <Card key={x.id} className="flex items-center justify-between p-3 text-sm">
                    <span>{x.number} · {short(x.date)} · {x.notes ?? ''}</span>
                    <span className="flex items-center gap-2">
                      {x.billable && <Badge variant="outline" className="text-[10px]">{x.billed ? 'Re-charged' : 'Billable'}</Badge>}
                      <Money value={x.totalPaise} />
                    </span>
                  </Card>
                ))}
                {!d.expenses.length && <p className="text-sm text-muted-foreground">No expenses booked to this project. Pick it on an expense to book one here.</p>}
              </TabsContent>
              <TabsContent value="invoices" className="mt-4 space-y-2">
                {d.invoices.map((i) => (
                  <Card key={i.id} className="flex items-center justify-between p-3 text-sm">
                    <Link href={`/sales/invoices/${i.id}`} className="font-medium text-primary hover:underline">{i.number}</Link>
                    <span className="flex items-center gap-3">{short(i.date)} <StatusBadge status={i.status} /> <Money value={i.totalPaise} /></span>
                  </Card>
                ))}
                {!d.invoices.length && <p className="text-sm text-muted-foreground">Not billed yet.</p>}
              </TabsContent>
              <TabsContent value="activity" className="mt-4">
                <ActivityPanel targetType="project" targetId={p.id} />
              </TabsContent>
              <TabsContent value="setup" className="mt-4 grid gap-4 lg:grid-cols-2">
                <CustomFieldsPanel entity="project" id={p.id} canEdit={canEdit} className="space-y-3 p-4 lg:col-span-2" />
                <Card className="p-4">
                  <p className="mb-2 text-sm font-semibold">Tasks</p>
                  {d.tasks.filter((t) => t.isActive).map((t) => (
                    <p key={t.id} className="flex justify-between border-t py-1.5 text-sm">
                      <span>{t.name}{!t.billable && <span className="text-xs text-muted-foreground"> · not billable</span>}</span>
                      {p.billingMethod === 'task_hours' && <Money value={t.ratePaise} />}
                    </p>
                  ))}
                  {!d.tasks.length && <p className="text-sm text-muted-foreground">No tasks.</p>}
                </Card>
                <Card className="p-4">
                  <p className="mb-2 text-sm font-semibold">People</p>
                  {d.users.map((u) => (
                    <p key={u.userId} className="flex justify-between border-t py-1.5 text-sm">
                      <span>{u.name}</span>
                      <span className="text-xs text-muted-foreground">{p.billingMethod === 'staff_hours' ? `bills ${formatINR(u.ratePaise)} · ` : ''}costs {formatINR(u.costRatePaise)} an hour</span>
                    </p>
                  ))}
                  {!d.users.length && <p className="text-sm text-muted-foreground">Nobody named; anyone may log time.</p>}
                </Card>
              </TabsContent>
            </Tabs>

            <ProjectDialog open={editing} onOpenChange={setEditing} existing={d} onSaved={() => state.refetch()} />
            <LogTimeDialog open={logging} onOpenChange={setLogging} projectId={p.id} onLogged={() => state.refetch()} />
            <Dialog open={billing} onOpenChange={setBilling}>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>Bill {p.name}</DialogTitle>
                  <DialogDescription>Raises an invoice to {p.customerName} for what is unbilled, at {p.gstRatePct}% GST{p.sacCode ? ` under SAC ${p.sacCode}` : ''}.</DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Invoice date"><Input type="date" value={bill.date} onChange={(e) => setBill({ ...bill, date: e.target.value })} /></Field>
                  <Field label="Due"><Input type="date" value={bill.dueDate} onChange={(e) => setBill({ ...bill, dueDate: e.target.value })} /></Field>
                  <Field label="Time and expenses up to" className="sm:col-span-2"><Input type="date" value={bill.through} onChange={(e) => setBill({ ...bill, through: e.target.value })} /></Field>
                  {d.unbilled.fixed && (
                    <Field label="Part of the fee to bill" className="sm:col-span-2" hint={`${formatINR(d.unbilled.fixed.leftPaise)} left`}>
                      <MoneyInput valuePaise={bill.fixedPaise} onChangePaise={(v) => setBill({ ...bill, fixedPaise: v })} />
                    </Field>
                  )}
                  <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm sm:col-span-2">
                    <span>Re-charge billable expenses</span>
                    <Switch checked={bill.includeExpenses} onCheckedChange={(v) => setBill({ ...bill, includeExpenses: v })} />
                  </label>
                  <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm sm:col-span-2">
                    <span>Issue it now<span className="block text-xs text-muted-foreground">Off: saved as a draft to check first.</span></span>
                    <Switch checked={bill.issue} onCheckedChange={(v) => setBill({ ...bill, issue: v })} />
                  </label>
                </div>
                {billAction.error && <p className="text-sm text-destructive">{billAction.error}</p>}
                <DialogFooter>
                  <Button variant="outline" onClick={() => setBilling(false)}>Cancel</Button>
                  <Button onClick={() => doBill(d)} disabled={billAction.busy} className="gap-1.5"><Plus className="size-4" /> {billAction.busy ? 'Raising…' : 'Raise invoice'}</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        );
      }}
    </AsyncPage>
  );
}
