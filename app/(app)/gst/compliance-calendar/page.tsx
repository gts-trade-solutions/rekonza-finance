'use client';

// The compliance calendar: every return, payment and form this book owes, by
// due date, worked out from its profile (Settings → Statutory) and marked done
// as each is filed. The dates are the statutory ones; when the government
// extends one, the obligation stays and only the date moves.

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, Clock, Loader2, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import { usePermission } from '@/lib/store/hooks';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { today } from '@/lib/selectors';
import { cn } from '@/lib/utils';

type Area = 'gst' | 'tds' | 'income_tax' | 'roc' | 'msme' | 'payroll';
interface Row {
  key: string; period: string; periodLabel: string; title: string; area: Area; dueDate: string; detail: string;
  href?: string; optional?: boolean;
  status: 'done' | 'overdue' | 'due_soon' | 'upcoming'; daysLeft: number;
  done: { on: string; reference: string | null; by: string | null } | null;
}
interface Calendar {
  profile: {
    registration: string; frequency: string; einvoicing: boolean; deductsTds: boolean; collectsTcs: boolean;
    company: boolean; owesMsmes: boolean; lutValidTo: string | null;
  };
  rows: Row[];
}

const AREA: Record<Area, string> = { gst: 'GST', tds: 'TDS / TCS', income_tax: 'Income tax', roc: 'Companies Act', msme: 'MSME', payroll: 'Payroll' };
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const fyStart = (iso: string) => (Number(iso.slice(5, 7)) >= 4 ? Number(iso.slice(0, 4)) : Number(iso.slice(0, 4)) - 1);
const day = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const monthOf = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

const RANGES = {
  ahead: { label: 'Next four months', range: (t: string) => ({ from: shift(t, -60), to: shift(t, 120) }) },
  fy: { label: 'This financial year', range: (t: string) => ({ from: `${fyStart(t)}-04-01`, to: `${fyStart(t) + 1}-03-31` }) },
  next: { label: 'Rest of the year after', range: (t: string) => ({ from: `${fyStart(t) + 1}-04-01`, to: `${fyStart(t) + 2}-03-31` }) },
} as const;

export default function ComplianceCalendarPage() {
  const canEdit = usePermission('gst', 'edit');
  const [range, setRange] = useState<keyof typeof RANGES>('ahead');
  const [area, setArea] = useState<Area | 'all'>('all');
  const [marking, setMarking] = useState<Row | null>(null);
  const { from, to } = RANGES[range].range(today());
  const state = useApi<Calendar>(() => api.get('/api/compliance-calendar', { from, to }), [from, to]);

  const undo = async (r: Row) => {
    try {
      await api.post('/api/compliance-calendar', { action: 'undo', key: r.key, period: r.period });
      toast.success(`${r.title} for ${r.periodLabel} unmarked`);
      void state.refetch();
    } catch (e) {
      toast.error('Not changed', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Compliance Calendar"
        description="Every return, payment and form this book owes, by due date. Mark each one done as it is filed."
      />

      <AsyncPage state={state} loading={<LoadingRows rows={10} />}>
        {(d) => (
          <Body d={d} range={range} setRange={setRange} area={area} setArea={setArea} canEdit={canEdit} onMark={setMarking} onUndo={undo} />
        )}
      </AsyncPage>

      <MarkDone row={marking} onClose={() => setMarking(null)} onDone={() => { setMarking(null); void state.refetch(); }} />
    </div>
  );
}

function Body({ d, range, setRange, area, setArea, canEdit, onMark, onUndo }: {
  d: Calendar; range: keyof typeof RANGES; setRange: (r: keyof typeof RANGES) => void;
  area: Area | 'all'; setArea: (a: Area | 'all') => void; canEdit: boolean;
  onMark: (r: Row) => void; onUndo: (r: Row) => void;
}) {
  const rows = d.rows.filter((r) => area === 'all' || r.area === area);
  const byMonth = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of rows) {
      const k = r.dueDate.slice(0, 7);
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return [...m.entries()];
  }, [rows]);
  const overdue = d.rows.filter((r) => r.status === 'overdue' && !r.optional).length;
  const soon = d.rows.filter((r) => r.status === 'due_soon' && !r.optional).length;
  const p = d.profile;
  const areas = [...new Set(d.rows.map((r) => r.area))];

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4 text-sm">
        <span className="text-muted-foreground">Worked out for</span>
        <Badge variant="outline">{p.registration[0].toUpperCase() + p.registration.slice(1)}{p.registration === 'regular' ? `, ${p.frequency} returns` : ''}</Badge>
        {p.einvoicing && <Badge variant="outline">E-invoicing</Badge>}
        {p.deductsTds && <Badge variant="outline">Deducts TDS{p.collectsTcs ? ' and TCS' : ''}</Badge>}
        {p.company && <Badge variant="outline">Company</Badge>}
        {p.lutValidTo && <Badge variant="outline">Exports under LUT</Badge>}
        <Link href="/settings?tab=statutory" className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline">
          Not right? Settings → Statutory <ArrowRight className="size-3" />
        </Link>
      </Card>

      {(overdue > 0 || soon > 0) && (
        <Card className={cn('flex items-start gap-3 p-4', overdue ? 'border-red-500/40 bg-red-500/5' : 'border-amber-500/40 bg-amber-500/5')}>
          <AlertTriangle className={cn('mt-0.5 size-4 shrink-0', overdue ? 'text-red-600' : 'text-amber-600')} />
          <p className="text-sm">
            {overdue > 0 && <><span className="font-medium">{overdue} overdue.</span>{' '}</>}
            {soon > 0 && <>{soon} due in the next seven days. </>}
            Late GST returns carry a fee per day and interest at 18% on unpaid tax; late TDS deposits, interest at 1.5% a month.
          </p>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border p-0.5 text-xs">
          {(Object.keys(RANGES) as (keyof typeof RANGES)[]).map((k) => (
            <button key={k} type="button" onClick={() => setRange(k)}
              className={cn('rounded px-2.5 py-1', range === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>
              {RANGES[k].label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap rounded-md border p-0.5 text-xs">
          {(['all', ...areas] as (Area | 'all')[]).map((a) => (
            <button key={a} type="button" onClick={() => setArea(a)}
              className={cn('rounded px-2.5 py-1', area === a ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>
              {a === 'all' ? 'Everything' : AREA[a]}
            </button>
          ))}
        </div>
      </div>

      {byMonth.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">Nothing falls due in these dates.</Card>
      ) : byMonth.map(([month, items]) => (
        <Card key={month} className="gap-0 overflow-hidden p-0">
          <div className="border-b bg-muted/40 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {monthOf(`${month}-01`)}
          </div>
          <ul className="divide-y">
            {items.map((r) => (
              <li key={`${r.key}|${r.period}`} className={cn('flex flex-wrap items-start gap-3 px-4 py-3 text-sm', r.optional && r.status !== 'done' && 'opacity-70')}>
                <div className="w-24 shrink-0">
                  <p className="font-medium tabular-nums">{day(r.dueDate)}</p>
                  <Status r={r} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {r.href ? <Link href={r.href} className="hover:underline">{r.title}</Link> : r.title}
                    <span className="ml-2 font-normal text-muted-foreground">{r.periodLabel}</span>
                    {r.optional && <Badge variant="outline" className="ml-2 text-[10px]">If it applies</Badge>}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{r.detail}</p>
                  {r.done && (
                    <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
                      Done on {day(r.done.on)}{r.done.reference ? ` · ${r.done.reference}` : ''}{r.done.by ? ` · ${r.done.by}` : ''}
                    </p>
                  )}
                </div>
                <Badge variant="secondary" className="text-[10px]">{AREA[r.area]}</Badge>
                {canEdit && (r.done
                  ? <Button size="sm" variant="ghost" className="gap-1" onClick={() => onUndo(r)}><Undo2 className="size-3.5" /> Undo</Button>
                  : <Button size="sm" variant="outline" onClick={() => onMark(r)}>Mark done</Button>)}
              </li>
            ))}
          </ul>
        </Card>
      ))}
      <p className="text-xs text-muted-foreground">
        Statutory due dates. The government often extends them by notification; an extension moves the date, not the obligation.
        Company filings assume the AGM is held by 30 September.
      </p>
    </div>
  );
}

function Status({ r }: { r: Row }) {
  if (r.status === 'done') return <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="size-3" /> Done</p>;
  if (r.status === 'overdue') return <p className="mt-0.5 text-[11px] font-medium text-red-600">{-r.daysLeft} day{r.daysLeft === -1 ? '' : 's'} late</p>;
  if (r.status === 'due_soon') return <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-amber-600"><Clock className="size-3" />{r.daysLeft === 0 ? 'Today' : `In ${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'}`}</p>;
  return <p className="mt-0.5 text-[11px] text-muted-foreground">In {r.daysLeft} days</p>;
}

function MarkDone({ row, onClose, onDone }: { row: Row | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ doneOn: today(), reference: '' });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!row) return;
    setBusy(true);
    try {
      await api.post('/api/compliance-calendar', { action: 'done', key: row.key, period: row.period, doneOn: f.doneOn, reference: f.reference || null });
      toast.success(`${row.title} for ${row.periodLabel} marked done`);
      setF({ doneOn: today(), reference: '' });
      onDone();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!row} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{row?.title}: {row?.periodLabel}</DialogTitle>
          <DialogDescription>When it was filed or paid, and the acknowledgement: the ARN, challan number or SRN.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Done on"><Input type="date" value={f.doneOn} onChange={(e) => setF({ ...f, doneOn: e.target.value })} /></Field>
          <Field label="Reference"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder="ARN / CIN / SRN" /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !f.doneOn} className="gap-1.5">
            {busy && <Loader2 className="size-3.5 animate-spin" />} Mark done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
