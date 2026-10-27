'use client';

// Backups, as the people responsible for the books need to see them: how old
// the newest backup is, whether a restore has been proved lately, and whether
// the audit trail is locked in the database itself.

import { AlertTriangle, CheckCircle2, DatabaseBackup, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { AsyncPage } from '@/components/shared/async-state';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';

interface Run {
  kind: 'backup' | 'verify' | 'drill'; ok: boolean; startedAt: string; finishedAt: string | null;
  file: string | null; bytes: number | null; filesCount: number | null; detail: string | null; host: string | null;
  seconds: number | null;
}
interface BackupsResponse {
  lastBackup: Run | null; lastVerify: Run | null; lastDrill: Run | null; lastDrillFailure: Run | null;
  recoveryPointHours: number | null; databaseProtected: boolean; warnings: string[]; recent: Run[];
  targets: { backupDueHours: number; drillDueDays: number; rpoHours: number; rtoMinutes: number };
  recoveryPointMet: boolean; recoveryTimeMet: boolean | null;
}

const when = (iso: string | null) => (iso
  ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—');
const size = (b: number | null) => (b === null ? '' : b > 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`);
const KIND: Record<Run['kind'], string> = { backup: 'Backup', verify: 'Check', drill: 'Restore drill' };

export function BackupsPanel() {
  const state = useApi<BackupsResponse>(() => api.get('/api/settings/backups'), []);
  const canEdit = usePermission('settings', 'edit');
  const setTarget = async (patch: { rpoHours?: number; rtoMinutes?: number }) => {
    try {
      await api.put('/api/settings/policies', { recovery: patch });
      toast.success('Target saved');
      await state.refetch();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <AsyncPage state={state}>
      {(d) => (
        <div className="space-y-4">
          {d.warnings.length > 0 ? (
            <Card className="space-y-1.5 border-amber-500/40 bg-amber-500/5 p-4">
              {d.warnings.map((w) => (
                <p key={w} className="flex items-start gap-2 text-sm"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />{w}</p>
              ))}
            </Card>
          ) : (
            <Card className="flex items-center gap-2 border-emerald-500/40 bg-emerald-500/5 p-4 text-sm">
              <CheckCircle2 className="size-4 text-emerald-600" /> Backed up today, restore proved this month, trail locked.
            </Card>
          )}

          <Card className="space-y-3 p-4">
            <div>
              <h3 className="text-sm font-semibold">Recovery targets</h3>
              <p className="text-xs text-muted-foreground">
                What the business can live with after a disaster: how much work it may lose (the recovery point) and how long getting the
                books back may take (the recovery time). Checked against every backup and restore drill below.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex items-end gap-3">
                <label className="text-sm">
                  <span className="block text-xs font-medium">Lose at most</span>
                  <span className="flex items-center gap-1.5">
                    <Input type="number" min={1} max={168} defaultValue={d.targets.rpoHours} disabled={!canEdit} className="h-9 w-20"
                      onBlur={(e) => { const n = Number(e.target.value); if (n !== d.targets.rpoHours) void setTarget({ rpoHours: n }); }} />
                    hours of work
                  </span>
                </label>
                <Badge variant="outline" className={d.recoveryPointMet ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300' : 'border-amber-500/40 text-amber-700 dark:text-amber-300'}>
                  {d.recoveryPointMet ? 'Met' : 'Not met'}
                </Badge>
              </div>
              <div className="flex items-end gap-3">
                <label className="text-sm">
                  <span className="block text-xs font-medium">Restore within</span>
                  <span className="flex items-center gap-1.5">
                    <Input type="number" min={5} max={10080} defaultValue={d.targets.rtoMinutes} disabled={!canEdit} className="h-9 w-24"
                      onBlur={(e) => { const n = Number(e.target.value); if (n !== d.targets.rtoMinutes) void setTarget({ rtoMinutes: n }); }} />
                    minutes
                  </span>
                </label>
                <Badge variant="outline" className={d.recoveryTimeMet === null ? 'text-muted-foreground' : d.recoveryTimeMet ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300' : 'border-amber-500/40 text-amber-700 dark:text-amber-300'}>
                  {d.recoveryTimeMet === null ? 'No drill yet' : d.recoveryTimeMet ? 'Met' : 'Not met'}
                </Badge>
              </div>
            </div>
          </Card>

          <div className="grid gap-3 md:grid-cols-3">
            <Card className="p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Newest backup</p>
              <p className="mt-1 text-lg font-semibold">{d.lastBackup ? when(d.lastBackup.startedAt) : 'None yet'}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {d.recoveryPointHours !== null
                  ? <>At most {d.recoveryPointHours < 1 ? 'an hour' : `${Math.round(d.recoveryPointHours)} hours`} of work would be lost today (the recovery point). Target: under {d.targets.backupDueHours} hours.</>
                  : 'Schedule npm run db:backup daily.'}
              </p>
              {d.lastBackup && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {size(d.lastBackup.bytes)} · {d.lastBackup.filesCount ?? 0} attachment(s){d.lastBackup.host ? ` · on ${d.lastBackup.host}` : ''}
                </p>
              )}
            </Card>
            <Card className="p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Last restore proved</p>
              <p className="mt-1 text-lg font-semibold">{d.lastDrill ? when(d.lastDrill.startedAt) : 'Never'}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {d.lastDrill
                  ? <>Restored and matched against the live journal in {d.lastDrill.seconds ?? '?'}s — roughly how long a recovery would take (the recovery time).</>
                  : 'npm run db:backup -- drill restores the newest backup into a scratch database and checks it. Aim for monthly.'}
              </p>
              {d.lastDrillFailure && (!d.lastDrill || d.lastDrillFailure.startedAt > d.lastDrill.startedAt) && (
                <p className="mt-1 text-xs text-destructive">Last attempt failed: {d.lastDrillFailure.detail}</p>
              )}
            </Card>
            <Card className="p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Audit trail</p>
              <p className="mt-1 flex items-center gap-1.5 text-lg font-semibold">
                <ShieldCheck className={`size-4 ${d.databaseProtected ? 'text-emerald-600' : 'text-muted-foreground'}`} />
                {d.databaseProtected ? 'Locked in the database' : 'Locked by the app only'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                The app never edits or deletes the trail or a posted entry. With npm run db:protect the database refuses it too.
              </p>
            </Card>
          </div>

          <Card className="p-0">
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <DatabaseBackup className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">Recent runs</h3>
            </div>
            {d.recent.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">Nothing recorded yet.</p>
            ) : (
              <ul className="divide-y">
                {d.recent.map((r, i) => (
                  <li key={`${r.startedAt}-${i}`} className="flex flex-wrap items-start gap-3 px-4 py-2.5 text-sm">
                    <Badge variant="outline" className={`text-[10px] ${r.ok ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300' : 'border-red-500/40 text-red-700 dark:text-red-300'}`}>
                      {KIND[r.kind]} · {r.ok ? 'ok' : 'failed'}
                    </Badge>
                    <span className="w-40 shrink-0 text-xs text-muted-foreground">{when(r.startedAt)}</span>
                    <span className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">{r.file ? `${r.file} · ` : ''}{r.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <p className="text-xs leading-relaxed text-muted-foreground">
            How to schedule backups, where to keep them (in India, on another machine), and how long: docs/backups.md.
          </p>
        </div>
      )}
    </AsyncPage>
  );
}
