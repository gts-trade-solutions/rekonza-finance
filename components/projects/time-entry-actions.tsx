'use client';

// Edit and Delete on one time entry, on a project's Time tab and on the
// timesheet's cards (PUT /api/time-entries/[id], DELETE /api/time-entries).
// Visible buttons with their words, as the client asked (2026-11-25), not a
// bin alone. Billed time shows neither: the invoice is its record, and voiding
// or deleting the invoice frees it. A person changes their own time; someone
// else's needs the right to edit projects, as the server checks too.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Combobox } from '@/components/ui/combobox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/shared/form-bits';
import { DeleteConfirmDialog, RowActions } from '@/components/shared/row-actions';
import { useSession } from '@/components/layout/session-provider';
import { api, projects as projectApi, timeEntries, type ProjectDetail, type TimeEntryRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { hoursText, parseDuration } from './log-time-dialog';

type ProjectSetup = Pick<ProjectDetail['project'], 'billingMethod'> & { tasks: ProjectDetail['tasks'] };

/** Whether this person may change this entry (and it is not billed). */
export function useCanChangeTime(entry: Pick<TimeEntryRow, 'userId' | 'invoiceId'>) {
  const session = useSession();
  const canLog = usePermission('projects', 'create');
  const canManage = usePermission('projects', 'edit');
  return !entry.invoiceId && canLog && (entry.userId === session.user.id || canManage);
}

export function EditTimeDialog({ entry, projectId, project, open, onOpenChange, onSaved }: {
  entry: TimeEntryRow | null;
  projectId: string;
  /** The project's tasks and billing method, when the page has them; fetched otherwise. */
  project?: ProjectSetup;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const fetched = useApi<ProjectDetail | null>(() => (open && !project && projectId ? projectApi.get(projectId) : Promise.resolve(null)), [open, !!project, projectId]);
  const setup: ProjectSetup | null = project ?? (fetched.data ? { billingMethod: fetched.data.project.billingMethod, tasks: fetched.data.tasks } : null);
  const [taskId, setTaskId] = useState('');
  const [date, setDate] = useState('');
  const [duration, setDuration] = useState('');
  const [notes, setNotes] = useState('');
  const [billable, setBillable] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open || !entry) return;
    setTaskId(entry.taskId ?? '');
    setDate(entry.date);
    setDuration(hoursText(entry.minutes));
    setNotes(entry.notes ?? '');
    setBillable(entry.billable);
  }, [open, entry]);
  const minutes = parseDuration(duration);
  // Its own task stays offered even if since set inactive.
  const tasks = (setup?.tasks ?? []).filter((t) => t.isActive || t.id === entry?.taskId);

  const save = async () => {
    if (!entry) return;
    if (!minutes || minutes > 1440) { toast.error('Give how long, for example 1:30 or 1.5.'); return; }
    if (setup?.billingMethod === 'task_hours' && !taskId) { toast.error('This project is billed by task: pick the task.'); return; }
    setBusy(true);
    try {
      const r = await api.put<{ approvalStatus: string | null }>(`/api/time-entries/${entry.id}`, {
        taskId: taskId || null, date, minutes, notes: notes || null, billable,
      });
      toast.success(`${hoursText(minutes)} saved`, r.approvalStatus === 'pending' && entry.approvalStatus !== 'pending'
        ? { description: 'Changed time waits for approval again.' } : undefined);
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-slot="time-edit-dialog">
        <DialogHeader>
          <DialogTitle>Edit time</DialogTitle>
          <DialogDescription>
            {entry ? `${entry.userName}'s time${entry.projectName ? ` on ${entry.projectName}` : ''}. ` : ''}
            It stays on its project and with its person.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          {tasks.length > 0 && (
            <Field label="Task" required={setup?.billingMethod === 'task_hours'} className="sm:col-span-2">
              <Combobox options={tasks.map((t) => ({ value: t.id, label: t.name, sublabel: t.billable ? undefined : 'not billable' }))}
                value={taskId} onChange={setTaskId} placeholder="Pick a task" showAvatar={false} clearable />
            </Field>
          )}
          <Field label="Date" required>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-slot="time-edit-date" />
          </Field>
          <Field label="Time" required hint={minutes ? `${hoursText(minutes)} hours` : '1:30, 1.5 or 90m'}>
            <Input value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="1:30" data-slot="time-edit-duration" />
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was done" data-slot="time-edit-notes" />
          </Field>
          <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm sm:col-span-2">
            <span>Billable<span className="block text-xs text-muted-foreground">Off: kept for the record, never billed.</span></span>
            <Switch checked={billable} onCheckedChange={setBillable} />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy} data-slot="time-edit-save">{busy ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Edit and Delete for one entry, with their dialogs. Nothing when it is billed or not this person's to change. */
export function TimeEntryActions({ entry, projectId, project, onChanged, className }: {
  entry: TimeEntryRow;
  projectId: string;
  project?: ProjectSetup;
  onChanged: () => void;
  className?: string;
}) {
  const may = useCanChangeTime(entry);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  if (!may) return null;
  return (
    <>
      <RowActions className={className} onEdit={() => setEditing(true)} onDelete={() => setDeleting(true)}
        editTitle="Edit this time" deleteTitle="Delete this time" />
      <EditTimeDialog entry={editing ? entry : null} projectId={projectId} project={project} open={editing} onOpenChange={setEditing} onSaved={onChanged} />
      <DeleteConfirmDialog
        open={deleting} onOpenChange={setDeleting} withReason={false}
        title={`Delete ${hoursText(entry.minutes)} on ${new Date(`${entry.date}T00:00:00`).toLocaleDateString('en-IN')}?`}
        description="The time comes off the timesheet and the project. It was not billed, so no invoice changes. The audit trail keeps it."
        onConfirm={() => timeEntries.remove(entry.id)} doneMessage="Time deleted" onDone={onChanged}
      />
    </>
  );
}
