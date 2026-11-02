'use client';

// Logging time: a project, a task when the project has them, who, when, and
// how long — typed as 1:30, 1.5 or 90m. Someone who cannot manage projects
// logs their own time only, so the person picker is shown only to those who can.

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Combobox } from '@/components/ui/combobox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/shared/form-bits';
import { projects as projectApi, timeEntries, type ProjectDetail } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { useAppStore } from '@/lib/store';
import { userOptions } from '@/lib/options';
import { today } from '@/lib/selectors';

/** "1:30", "1.5", "1h 30m", "90m" or "90" (minutes when above 24) as minutes. */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  let m = t.match(/^(\d+):(\d{1,2})$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = t.match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+)\s*m)?$/);
  if (m && (m[1] || m[2])) return Math.round(Number(m[1] ?? 0) * 60) + Number(m[2] ?? 0);
  const n = Number(t);
  if (Number.isFinite(n) && n > 0) return n > 24 ? Math.round(n) : Math.round(n * 60);
  return null;
}

export const hoursText = (minutes: number) => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;

export function LogTimeDialog({
  open, onOpenChange, projectId: fixedProject, onLogged,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Logging from a project's page: that project, no picker. */
  projectId?: string;
  onLogged: () => void;
}) {
  const canManage = usePermission('projects', 'edit');
  const s = useAppStore();
  const people = useMemo(() => userOptions(s), [s]);
  const [projectId, setProjectId] = useState(fixedProject ?? '');
  const [taskId, setTaskId] = useState('');
  const [userId, setUserId] = useState('');
  const [date, setDate] = useState(today());
  const [duration, setDuration] = useState('');
  const [notes, setNotes] = useState('');
  const [billable, setBillable] = useState(true);
  const log = useApiAction(timeEntries.log);

  const list = useApi(() => (open && !fixedProject ? projectApi.list({ status: 'active' }) : Promise.resolve({ projects: [] })), [open, fixedProject]);
  const detail = useApi<ProjectDetail | null>(() => (open && projectId ? projectApi.get(projectId) : Promise.resolve(null)), [open, projectId]);
  useEffect(() => { if (fixedProject) setProjectId(fixedProject); }, [fixedProject]);
  useEffect(() => { setTaskId(''); }, [projectId]);
  const tasks = (detail.data?.tasks ?? []).filter((t) => t.isActive);
  const minutes = parseDuration(duration);

  const save = async () => {
    if (!projectId) { toast.error('Pick the project.'); return; }
    if (!minutes || minutes > 1440) { toast.error('Give how long, for example 1:30 or 1.5.'); return; }
    if (detail.data?.project.billingMethod === 'task_hours' && !taskId) { toast.error('This project is billed by task: pick the task.'); return; }
    const done = await log.run({ projectId, taskId: taskId || null, userId: userId || null, date, minutes, notes: notes || null, billable });
    if (!done) { toast.error(log.error ?? 'The time was not logged'); return; }
    toast.success(`${hoursText(minutes)} logged`);
    setDuration('');
    setNotes('');
    onLogged();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Log time</DialogTitle>
          <DialogDescription>Billable time waits on the project until it is billed on an invoice.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          {!fixedProject && (
            <Field label="Project" required className="sm:col-span-2">
              <Combobox options={(list.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name, sublabel: p.customerName }))}
                value={projectId} onChange={setProjectId} placeholder="Pick a project" showAvatar={false} />
            </Field>
          )}
          {tasks.length > 0 && (
            <Field label="Task" required={detail.data?.project.billingMethod === 'task_hours'} className="sm:col-span-2">
              <Combobox options={tasks.map((t) => ({ value: t.id, label: t.name, sublabel: t.billable ? undefined : 'not billable' }))}
                value={taskId} onChange={setTaskId} placeholder="Pick a task" showAvatar={false} clearable />
            </Field>
          )}
          {canManage && (
            <Field label="Who" hint="Left empty, you" className="sm:col-span-2">
              <Combobox options={people} value={userId} onChange={setUserId} placeholder="You" clearable />
            </Field>
          )}
          <Field label="Date" required>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Time" required hint={minutes ? `${hoursText(minutes)} hours` : '1:30, 1.5 or 90m'}>
            <Input value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="1:30" data-slot="log-duration" />
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was done" />
          </Field>
          <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm sm:col-span-2">
            <span>Billable<span className="block text-xs text-muted-foreground">Off: logged for the record, never billed.</span></span>
            <Switch checked={billable} onCheckedChange={setBillable} />
          </label>
        </div>
        {log.error && <p className="text-sm text-destructive">{log.error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={log.busy}>{log.busy ? 'Logging…' : 'Log time'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
