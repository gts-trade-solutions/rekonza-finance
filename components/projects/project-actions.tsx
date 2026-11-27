'use client';

// Delete on a project, and Edit and Delete on each of its tasks (2026-11-25:
// visible buttons with their words, as the client looks for them).
//
// A project with time, expenses, bills or invoices on it cannot be deleted —
// the server says what is on it (code `in_use`) and the dialog offers Zoho's
// way out instead: archive it, so it is no longer offered but its history
// stays. A task with time logged to it is set inactive rather than deleted,
// for the same reason (DELETE /api/projects/[id]/tasks/[taskId]).

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { DeleteConfirmDialog, RowActions, withReasonQuery } from '@/components/shared/row-actions';
import { api, projects as projectApi, type ProjectDetail } from '@/lib/api/client';
import { usePermission } from '@/lib/store/hooks';

/** Delete a project, asked once; refused while anything rests on it, with Archive offered. */
export function DeleteProjectDialog({ project, open, onOpenChange, onDeleted, onArchived }: {
  project: { id: string; name: string; status: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
  /** After archiving instead; defaults to onDeleted. */
  onArchived?: () => void;
}) {
  // The dialog calls onDone after either way out; this says which it was.
  const archived = useRef(false);
  if (!project) return null;
  return (
    <DeleteConfirmDialog
      open={open} onOpenChange={(o) => { if (o) archived.current = false; onOpenChange(o); }}
      title={`Delete project ${project.name}?`}
      description="The project, its tasks and the people on it are removed. Only a project with nothing logged, booked or billed to it can be deleted; otherwise archive it."
      onConfirm={async (reason) => { archived.current = false; await api.delete(withReasonQuery(`/api/projects/${project.id}`, reason)); }}
      doneMessage={`${project.name} deleted`}
      onDone={() => (archived.current ? (onArchived ?? onDeleted)() : onDeleted())}
      inUse={project.status === 'archived' ? undefined : {
        label: 'Mark as archived',
        run: async () => { await projectApi.setStatus(project.id, 'archived'); archived.current = true; },
        doneMessage: `${project.name} archived`,
      }}
    />
  );
}

type Task = ProjectDetail['tasks'][number];

function EditTaskDialog({ projectId, task, showRate, open, onOpenChange, onSaved }: {
  projectId: string; task: Task; showRate: boolean; open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void;
}) {
  const [name, setName] = useState(task.name);
  const [rate, setRate] = useState(task.ratePaise);
  const [billable, setBillable] = useState(task.billable);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) { setName(task.name); setRate(task.ratePaise); setBillable(task.billable); }
  }, [open, task]);
  const save = async () => {
    if (!name.trim()) { toast.error('Give the task a name.'); return; }
    setBusy(true);
    try {
      await api.patch(`/api/projects/${projectId}/tasks/${task.id}`, { name: name.trim(), ratePaise: rate, billable });
      toast.success(`${name.trim()} saved`);
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
      <DialogContent className="max-w-md" data-slot="task-edit-dialog">
        <DialogHeader>
          <DialogTitle>Edit task</DialogTitle>
          <DialogDescription>Time already billed keeps the rate it was billed at; time still unbilled is billed at the new one.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Task" required><Input value={name} onChange={(e) => setName(e.target.value)} data-slot="task-edit-name" /></Field>
          {showRate && <Field label="Rate an hour"><MoneyInput valuePaise={rate} onChangePaise={setRate} /></Field>}
          <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
            <span>Billable<span className="block text-xs text-muted-foreground">Off: time on it is logged for the record, never billed.</span></span>
            <Switch checked={billable} onCheckedChange={setBillable} />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy} data-slot="task-edit-save">{busy ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Edit and Delete on one task of the project's Tasks card. */
export function TaskActions({ projectId, task, showRate, onChanged }: {
  projectId: string; task: Task; showRate: boolean; onChanged: () => void;
}) {
  const canEdit = usePermission('projects', 'edit');
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  if (!canEdit) return null;
  return (
    <>
      <RowActions onEdit={() => setEditing(true)} onDelete={() => setDeleting(true)} editTitle={`Edit ${task.name}`} deleteTitle={`Delete ${task.name}`} />
      <EditTaskDialog projectId={projectId} task={task} showRate={showRate} open={editing} onOpenChange={setEditing} onSaved={onChanged} />
      <DeleteConfirmDialog
        open={deleting} onOpenChange={setDeleting} withReason={false}
        title={`Delete task ${task.name}?`}
        description="A task nobody has logged time to is removed. One with time on it is set inactive instead: its hours stay, billed or waiting to be, and it is no longer offered for new time."
        onConfirm={async () => {
          const r = await api.delete<{ removed: boolean }>(`/api/projects/${projectId}/tasks/${task.id}`);
          toast.success(r.removed ? `${task.name} deleted` : `${task.name} set inactive`, r.removed ? undefined : { description: 'Time is logged to it, so it is kept for that time.' });
        }}
        onDone={onChanged}
      />
    </>
  );
}
