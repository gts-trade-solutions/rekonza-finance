'use client';

// Scheduled reports: made on their day for the period that day implies, kept
// here as workbooks, and announced under the bell to the people they are for.

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { CalendarClock, Download, Loader2, Play, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';

interface Schedule { id: string; name: string; report: string; period: string; frequency: 'daily' | 'weekly' | 'monthly'; nextRun: string; recipients: string[]; isActive: boolean; lastRunAt: string | null; lastError: string | null }
interface ReportFile { id: string; scheduleId: string | null; report: string; name: string; from: string | null; to: string; bytes: number; at: string }
interface Data {
  schedules: Schedule[]; files: ReportFile[]; users: { id: string; name: string }[];
  reports: { value: string; label: string }[]; periods: { value: string; label: string }[];
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const dmy = (d: string) => new Date(d).toLocaleDateString('en-IN');
const tomorrow = () => new Date(Date.now() + 864e5).toISOString().slice(0, 10);

export default function ScheduledReportsPage() {
  return <Suspense fallback={<LoadingRows rows={6} />}><Scheduled /></Suspense>;
}

function Scheduled() {
  const params = useSearchParams();
  const highlight = params.get('file');
  const me = useAppStore((s) => s.session?.userId);
  const state = useApi(() => api.get<Data>('/api/report-schedules'), []);
  const [f, setF] = useState({ name: '', report: 'profit-and-loss', period: 'last_month', frequency: 'monthly' as Schedule['frequency'], firstRun: tomorrow(), recipients: [] as string[] });
  const [busy, setBusy] = useState<string | null>(null);

  const post = async <T,>(key: string, payload: Record<string, unknown>, done?: string) => {
    setBusy(key);
    try {
      const r = await api.post<T>('/api/report-schedules', payload);
      if (done) toast.success(done);
      await state.refetch();
      return r;
    } catch (e) {
      toast.error('Not done', { description: errorText(e) });
      return null;
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader title="Scheduled reports" description="Reports made on their own — last month's profit and loss on the 1st, the receivables ageing every Monday — kept here and announced under the bell." />
      <AsyncPage state={state} loading={<LoadingRows rows={6} />}>
        {(d) => {
          const recipients = f.recipients.length ? f.recipients : me ? [me] : [];
          const name = (id: string) => d.users.find((u) => u.id === id)?.name ?? 'someone';
          const label = (r: string) => d.reports.find((x) => x.value === r)?.label ?? r;
          return (
            <div className="space-y-4">
              <Card className="space-y-3 p-5">
                <h3 className="text-sm font-semibold">New schedule</h3>
                <div className="grid gap-3 sm:grid-cols-5">
                  <Field label="Report">
                    <div>
                      <select value={f.report} onChange={(e) => setF({ ...f, report: e.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                        {d.reports.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                    </div>
                  </Field>
                  <Field label="Covering">
                    <div>
                      <select value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                        {d.periods.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                      </select>
                    </div>
                  </Field>
                  <Field label="Every">
                    <div>
                      <select value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value as Schedule['frequency'] })} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                        <option value="daily">Day</option><option value="weekly">Week</option><option value="monthly">Month</option>
                      </select>
                    </div>
                  </Field>
                  <Field label="First made on"><Input type="date" value={f.firstRun} onChange={(e) => setF({ ...f, firstRun: e.target.value })} /></Field>
                  <Field label="Name (optional)"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={label(f.report)} /></Field>
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">For</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {d.users.map((u) => (
                      <label key={u.id} className="flex items-center gap-1.5 text-sm">
                        <Checkbox checked={recipients.includes(u.id)} onCheckedChange={(v) => setF({ ...f, recipients: v ? [...recipients, u.id] : recipients.filter((x) => x !== u.id) })} />
                        {u.name}
                      </label>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">Anyone whose role does not include the report is left out when it is made.</p>
                </div>
                <Button size="sm" className="w-fit gap-1.5" disabled={busy === 'new' || !recipients.length}
                  onClick={() => void post('new', { action: 'save', ...f, recipients }, 'Scheduled').then((r) => r && setF({ ...f, name: '' }))}>
                  {busy === 'new' ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Schedule
                </Button>
              </Card>

              {d.schedules.length > 0 && (
                <Card className="p-0">
                  <ul className="divide-y text-sm">
                    {d.schedules.map((s) => (
                      <li key={s.id} className={cn('flex flex-wrap items-center gap-3 px-4 py-3', !s.isActive && 'opacity-60')}>
                        <CalendarClock className="size-4 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">{s.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {label(s.report)} · {d.periods.find((p) => p.value === s.period)?.label} · every {s.frequency === 'daily' ? 'day' : s.frequency === 'weekly' ? 'week' : 'month'} · next {dmy(s.nextRun)} · for {s.recipients.map(name).join(', ')}
                          </p>
                          {s.lastError && <p className="text-xs text-destructive">{s.lastError}</p>}
                        </div>
                        <Button size="xs" variant="outline" className="gap-1" disabled={busy === s.id}
                          onClick={() => void post<{ recipients: number }>(s.id, { action: 'run', id: s.id }).then((r) => r && toast.success('Made now', { description: `Announced to ${r.recipients} ${r.recipients === 1 ? 'person' : 'people'}.` }))}>
                          {busy === s.id ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />} Make now
                        </Button>
                        <Switch checked={s.isActive} aria-label="On" onCheckedChange={(v) => void post(s.id, { action: 'save', id: s.id, name: s.name, report: s.report, period: s.period, frequency: s.frequency, firstRun: s.nextRun, recipients: s.recipients, isActive: v }, v ? 'On' : 'Paused')} />
                        <Button size="icon-sm" variant="ghost" aria-label="Delete schedule" onClick={() => window.confirm(`Delete ${s.name}? Files already made stay.`) && void post(s.id, { action: 'delete', id: s.id }, 'Deleted')}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              <Card className="space-y-2 p-5">
                <h3 className="text-sm font-semibold">Made so far</h3>
                {d.files.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing yet. A schedule&apos;s first workbook appears here on its first day, or straight away with Make now.</p>
                ) : (
                  <ul className="divide-y rounded-md border text-sm">
                    {d.files.map((x) => (
                      <li key={x.id} className={cn('flex flex-wrap items-center gap-2 px-3 py-2', highlight === x.id && 'bg-primary/5')}>
                        <span className="font-medium">{x.name}</span>
                        {highlight === x.id && <Badge variant="outline" className="text-[10px]">From your notification</Badge>}
                        <span className="text-xs text-muted-foreground">{new Date(x.at).toLocaleString('en-IN')} · {(x.bytes / 1024).toFixed(0)} KB</span>
                        <a href={`/api/report-files/${x.id}`} className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                          <Download className="size-3.5" /> Excel
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          );
        }}
      </AsyncPage>
    </>
  );
}
