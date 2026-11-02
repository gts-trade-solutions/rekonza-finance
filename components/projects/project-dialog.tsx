'use client';

// A project's set-up: whom it is for, how it is billed, and the tasks and
// people on it with their rates. The rates shown depend on the billing method:
// a fixed fee needs only the fee, project hours one rate, task hours a rate on
// each task, staff hours a rate on each person. A cost rate on each person is
// what their hour costs the business, for the project's profit.

import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Combobox } from '@/components/ui/combobox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ContactPicker } from '@/components/forms/quick-create';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { projects as projectApi, type BillingMethod, type ProjectDetail } from '@/lib/api/client';
import { useApiAction } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { userOptions } from '@/lib/options';

export const METHOD_LABEL: Record<BillingMethod, string> = {
  fixed: 'Fixed fee',
  project_hours: 'By project hours',
  task_hours: 'By task hours',
  staff_hours: 'By staff hours',
};
const METHODS = (Object.keys(METHOD_LABEL) as BillingMethod[]).map((k) => ({ value: k, label: METHOD_LABEL[k] }));

type TaskRow = { id: string | null; name: string; ratePaise: number; billable: boolean };
type UserRow = { userId: string; ratePaise: number; costRatePaise: number };

export function ProjectDialog({
  open, onOpenChange, existing, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  existing?: ProjectDetail | null;
  onSaved: (id: string) => void;
}) {
  const s = useAppStore();
  const people = useMemo(() => userOptions(s), [s]);
  const [f, setF] = useState({
    name: '', customerId: '', code: '', billingMethod: 'project_hours' as BillingMethod, ratePaise: 0, fixedAmountPaise: 0,
    budgetHours: '', sacCode: '', gstRatePct: 18, startDate: '', endDate: '', description: '',
  });
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const save = useApiAction(projectApi.save);

  useEffect(() => {
    if (!open) return;
    if (existing) {
      const p = existing.project;
      setF({
        name: p.name, customerId: p.customerId, code: p.code ?? '', billingMethod: p.billingMethod, ratePaise: p.ratePaise,
        fixedAmountPaise: p.fixedAmountPaise, budgetHours: p.budgetHours == null ? '' : String(p.budgetHours), sacCode: p.sacCode ?? '',
        gstRatePct: p.gstRatePct, startDate: p.startDate ?? '', endDate: p.endDate ?? '', description: p.description ?? '',
      });
      setTasks(existing.tasks.filter((t) => t.isActive).map((t) => ({ id: t.id, name: t.name, ratePaise: t.ratePaise, billable: t.billable })));
      setUsers(existing.users.map((u) => ({ userId: u.userId, ratePaise: u.ratePaise, costRatePaise: u.costRatePaise })));
    } else {
      setF((x) => ({ ...x, name: '', customerId: '', code: '', description: '' }));
      setTasks([]);
      setUsers([]);
    }
  }, [open, existing]);

  const submit = async () => {
    if (!f.name.trim() || !f.customerId) { toast.error('Name the project and pick the customer.'); return; }
    const done = await save.run({
      id: existing?.project.id ?? null,
      name: f.name.trim(), customerId: f.customerId, code: f.code || null, description: f.description || null,
      billingMethod: f.billingMethod, ratePaise: f.ratePaise, fixedAmountPaise: f.fixedAmountPaise,
      budgetHours: f.budgetHours ? Number(f.budgetHours) : null, sacCode: f.sacCode || null, gstRatePct: f.gstRatePct,
      startDate: f.startDate || null, endDate: f.endDate || null,
      tasks: tasks.filter((t) => t.name.trim()).map((t) => ({ id: t.id, name: t.name, ratePaise: t.ratePaise, billable: t.billable })),
      users: users.filter((u) => u.userId),
    });
    if (!done) { toast.error(save.error ?? 'The project was not saved'); return; }
    toast.success(existing ? 'Project saved' : 'Project created');
    onSaved(done.id);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit project' : 'New project'}</DialogTitle>
          <DialogDescription>How it is billed decides which rates it needs.</DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[65vh] gap-4 overflow-y-auto pr-1 sm:grid-cols-2 thin-scroll">
          <Field label="Project name" required>
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="ERP rollout" />
          </Field>
          <Field label="Customer" required>
            <ContactPicker kind="customer" value={f.customerId} onChange={(v) => setF({ ...f, customerId: v })} placeholder="Who it is for" />
          </Field>
          <Field label="Billing method" required>
            <Combobox options={METHODS} value={f.billingMethod} onChange={(v) => setF({ ...f, billingMethod: v as BillingMethod })} showAvatar={false} />
          </Field>
          {f.billingMethod === 'fixed' && (
            <Field label="Fee" required hint="Billed in whole or in parts">
              <MoneyInput valuePaise={f.fixedAmountPaise} onChangePaise={(p) => setF({ ...f, fixedAmountPaise: p })} />
            </Field>
          )}
          {f.billingMethod === 'project_hours' && (
            <Field label="Rate an hour" required>
              <MoneyInput valuePaise={f.ratePaise} onChangePaise={(p) => setF({ ...f, ratePaise: p })} />
            </Field>
          )}
          {(f.billingMethod === 'task_hours' || f.billingMethod === 'staff_hours') && (
            <p className="self-end pb-2 text-xs text-muted-foreground">
              {f.billingMethod === 'task_hours' ? 'Each task below carries its own rate.' : 'Each person below carries their own rate.'}
            </p>
          )}
          <Field label="SAC code" hint="Must be on your approved list (Settings → HSN & SAC)">
            <Input value={f.sacCode} onChange={(e) => setF({ ...f, sacCode: e.target.value.replace(/\D/g, '').slice(0, 8) })} placeholder="998311" />
          </Field>
          <Field label="GST rate">
            <Combobox options={[0, 5, 12, 18, 28].map((r) => ({ value: String(r), label: `${r}%` }))} value={String(f.gstRatePct)}
              onChange={(v) => setF({ ...f, gstRatePct: Number(v) })} showAvatar={false} />
          </Field>
          <Field label="Budget (hours)" hint="Optional">
            <Input type="number" min={0} value={f.budgetHours} onChange={(e) => setF({ ...f, budgetHours: e.target.value })} />
          </Field>
          <Field label="Code" hint="Optional">
            <Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="PRJ-014" />
          </Field>
          <Field label="Starts">
            <Input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
          </Field>
          <Field label="Ends">
            <Input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
          </Field>

          <div className="space-y-2 sm:col-span-2" data-slot="project-tasks">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Tasks</p>
              <Button size="sm" variant="ghost" onClick={() => setTasks([...tasks, { id: null, name: '', ratePaise: 0, billable: true }])}><Plus className="size-3.5" /> Task</Button>
            </div>
            {tasks.map((t, i) => (
              <div key={i} className="grid grid-cols-[1fr_140px_auto_auto] items-center gap-2">
                <Input value={t.name} onChange={(e) => setTasks(tasks.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Task" />
                <MoneyInput valuePaise={t.ratePaise} onChangePaise={(p) => setTasks(tasks.map((x, j) => (j === i ? { ...x, ratePaise: p } : x)))} />
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Switch checked={t.billable} onCheckedChange={(v) => setTasks(tasks.map((x, j) => (j === i ? { ...x, billable: v } : x)))} /> Billable
                </label>
                <Button size="icon-sm" variant="ghost" aria-label="Remove task" onClick={() => setTasks(tasks.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
              </div>
            ))}
          </div>

          <div className="space-y-2 sm:col-span-2" data-slot="project-users">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">People <span className="text-xs font-normal text-muted-foreground">· billing rate, and what their hour costs</span></p>
              <Button size="sm" variant="ghost" onClick={() => setUsers([...users, { userId: '', ratePaise: 0, costRatePaise: 0 }])}><Plus className="size-3.5" /> Person</Button>
            </div>
            {users.map((u, i) => (
              <div key={i} className="grid grid-cols-[1fr_130px_130px_auto] items-center gap-2">
                <Combobox options={people} value={u.userId} onChange={(v) => setUsers(users.map((x, j) => (j === i ? { ...x, userId: v } : x)))} placeholder="Person" />
                <MoneyInput valuePaise={u.ratePaise} onChangePaise={(p) => setUsers(users.map((x, j) => (j === i ? { ...x, ratePaise: p } : x)))} />
                <MoneyInput valuePaise={u.costRatePaise} onChangePaise={(p) => setUsers(users.map((x, j) => (j === i ? { ...x, costRatePaise: p } : x)))} />
                <Button size="icon-sm" variant="ghost" aria-label="Remove person" onClick={() => setUsers(users.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
              </div>
            ))}
          </div>
        </div>
        {save.error && <p className="text-sm text-destructive">{save.error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={save.busy}>{save.busy ? 'Saving…' : existing ? 'Save project' : 'Create project'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
