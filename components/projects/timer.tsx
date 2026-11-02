'use client';

// The timer on the timesheet, as Zoho's: pick the project (and task), start
// it, and stopping it logs the time; and the approvals panel for whoever
// approves timesheets (services/projects.ts).

import { useEffect, useMemo, useState } from 'react';
import { Check, Play, Square, Timer as TimerIcon, X } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import { projects as projectApi, timeEntries, type ProjectDetail, type TimeEntryRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { hoursText } from '@/components/projects/log-time-dialog';

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function TimerCard({ onLogged }: { onLogged: () => void }) {
  const state = useApi(() => timeEntries.timer(), []);
  const running = state.data?.timer ?? null;
  const list = useApi(() => (running ? Promise.resolve({ projects: [] }) : projectApi.list({ status: 'active' })), [!!running]);
  const [projectId, setProjectId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const detail = useApi<ProjectDetail | null>(() => (projectId && !running ? projectApi.get(projectId) : Promise.resolve(null)), [projectId, !!running]);
  const tasks = useMemo(() => (detail.data?.tasks ?? []).filter((t) => t.isActive), [detail.data]);
  useEffect(() => { setTaskId(''); }, [projectId]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  const start = async () => {
    if (!projectId) { toast.error('Pick the project.'); return; }
    if (detail.data?.project.billingMethod === 'task_hours' && !taskId) { toast.error('This project is billed by task: pick the task.'); return; }
    setBusy(true);
    try {
      await timeEntries.startTimer({ projectId, taskId: taskId || null, notes: notes || null });
      setNow(Date.now());
      state.refetch();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const stop = async (discard: boolean) => {
    if (discard && !window.confirm('Stop the timer without logging the time?')) return;
    setBusy(true);
    try {
      const r = discard ? await timeEntries.discardTimer() : await timeEntries.stopTimer(notes || null);
      if (r.entryId) toast.success(`${hoursText(r.minutes)} logged to ${running?.projectName}`);
      else toast.info('Timer stopped; nothing logged.');
      setNotes('');
      state.refetch();
      onLogged();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="flex flex-wrap items-center gap-3 p-3" data-slot="timer">
      <TimerIcon className="size-5 text-muted-foreground" />
      {running ? (
        <>
          <span className="font-mono text-xl tabular-nums" aria-live="off">{clock(now - new Date(running.startedAt).getTime())}</span>
          <span className="min-w-0 flex-1 text-sm">
            <b>{running.projectName}</b>{running.taskName ? ` · ${running.taskName}` : ''}
            <span className="block text-xs text-muted-foreground">Started {new Date(running.startedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
          </span>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={running.notes ?? 'What you worked on'} maxLength={500} className="h-8 w-56" />
          <Button size="sm" onClick={() => stop(false)} disabled={busy} className="gap-1.5"><Square className="size-3.5" /> Stop and log</Button>
          <Button size="sm" variant="ghost" onClick={() => stop(true)} disabled={busy}>Discard</Button>
        </>
      ) : (
        <>
          <div className="w-64">
            <Combobox options={(list.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name, sublabel: p.customerName }))}
              value={projectId} onChange={setProjectId} placeholder="Project to time" showAvatar={false} className="h-8" />
          </div>
          {tasks.length > 0 && (
            <select aria-label="Task" value={taskId} onChange={(e) => setTaskId(e.target.value)} className="h-8 rounded-md border border-input bg-background px-2 text-sm">
              <option value="">{detail.data?.project.billingMethod === 'task_hours' ? 'Pick the task' : 'No task'}</option>
              {tasks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What you are working on" maxLength={500} className="h-8 w-56" />
          <Button size="sm" onClick={start} disabled={busy || !projectId} className="gap-1.5"><Play className="size-3.5" /> Start timer</Button>
        </>
      )}
    </Card>
  );
}

export function ApprovalsPanel({ onDecided }: { onDecided: () => void }) {
  const state = useApi(() => timeEntries.list({ approvals: true }), []);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const rows: TimeEntryRow[] = state.data?.entries ?? [];

  const decide = async (decision: 'approved' | 'rejected') => {
    if (decision === 'rejected' && !note.trim()) { toast.error('Say why it is turned back, so it can be put right.'); return; }
    setBusy(true);
    try {
      const r = await timeEntries.decide([...picked], decision, note || null);
      toast.success(`${r.count} entr${r.count === 1 ? 'y' : 'ies'} ${decision === 'approved' ? 'approved' : 'turned back'}`);
      setPicked(new Set());
      setNote('');
      state.refetch();
      onDecided();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (state.loading) return <p className="text-sm text-muted-foreground">Loading time waiting for approval…</p>;
  if (state.error) return <p className="text-sm text-destructive">{state.error}</p>;
  if (!rows.length) return <Card className="p-4 text-sm text-muted-foreground">Nothing is waiting for your approval.</Card>;
  const total = rows.filter((r) => picked.has(r.id)).reduce((t, r) => t + r.minutes, 0);
  return (
    <Card className="space-y-3 p-0" data-slot="timesheet-approvals">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs text-muted-foreground">
          <tr>
            <th className="w-10 px-3 py-2"><Checkbox aria-label="Choose all" checked={picked.size === rows.length} onCheckedChange={(v) => setPicked(v ? new Set(rows.map((r) => r.id)) : new Set())} /></th>
            <th className="px-3 py-2 text-left font-medium">Date</th>
            <th className="px-3 py-2 text-left font-medium">Person</th>
            <th className="px-3 py-2 text-left font-medium">Project</th>
            <th className="px-3 py-2 text-left font-medium">Notes</th>
            <th className="px-3 py-2 text-right font-medium">Hours</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t">
              <td className="px-3 py-2"><Checkbox aria-label={`Choose ${r.userName} ${r.date}`} checked={picked.has(r.id)} onCheckedChange={(v) => setPicked((p) => { const n = new Set(p); if (v) n.add(r.id); else n.delete(r.id); return n; })} /></td>
              <td className="px-3 py-2 text-xs tabular-nums">{new Date(`${r.date}T00:00:00`).toLocaleDateString('en-IN')}</td>
              <td className="px-3 py-2">{r.userName}</td>
              <td className="px-3 py-2">{r.projectName}{r.taskName ? <span className="text-muted-foreground"> · {r.taskName}</span> : null} {!r.billable && <Badge variant="outline" className="text-[9px]">Not billable</Badge>}</td>
              <td className="px-3 py-2 text-xs text-muted-foreground">{r.notes}</td>
              <td className="px-3 py-2 text-right tabular-nums">{hoursText(r.minutes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center gap-2 border-t px-3 pb-3 pt-1">
        <span className="text-sm">{picked.size} chosen{picked.size ? `, ${hoursText(total)} h` : ''}</span>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (needed when turning back)" maxLength={300} className="h-8 w-72" />
        <Button size="sm" disabled={busy || !picked.size} onClick={() => decide('approved')} className="gap-1.5"><Check className="size-3.5" /> Approve</Button>
        <Button size="sm" variant="outline" disabled={busy || !picked.size} onClick={() => decide('rejected')} className="gap-1.5"><X className="size-3.5" /> Turn back</Button>
      </div>
    </Card>
  );
}
