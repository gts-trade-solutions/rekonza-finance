'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Return status: every return of the year on one page, filed or not.
//
// The compliance calendar lists obligations by due date; an auditor asks a
// different question — "which returns were filed for which period, and which
// were not?" — and wants the answer as a grid: each return a row, each month a
// column, the cell saying Filed (with its date and ARN), Filed late, Overdue,
// Due soon or Upcoming. Quarterly returns sit in their quarter's last month,
// annual ones in March. The same obligations and filings feed both screens.
//
// A cell opens the return's filing: for a GST return, the filing bar itself
// (filed or not, the late fee and interest when overdue, Mark as filed with
// the date and ARN, Edit and Delete of that mark, the lock after filing, and
// the offline upload steps); for the others (TDS, PF, ESI, ROC…), the date
// done and its reference, with Edit and Delete. And it links into the return
// for that very period.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { CheckCircle2, Download, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { downloadCsv } from '@/components/shared/report-shell';
import { EditButton, DeleteButton, useConfirmDelete } from '@/components/shared/row-actions';
import { ReturnFilingBar } from '@/components/gst/return-filing';
import { api, ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { FILING_RETURNS, type FilingReturn } from '@/lib/gst/filing';
import { returnHref } from '@/lib/gst/url-period';
import { cn } from '@/lib/utils';

type Status = 'done' | 'late' | 'overdue' | 'due_soon' | 'upcoming';
interface Row {
  key: string; period: string; periodLabel: string; title: string; area: string; dueDate: string; href?: string;
  status: 'done' | 'overdue' | 'due_soon' | 'upcoming'; daysLeft: number; done: { on: string; reference: string | null; by: string | null } | null;
  /** Payroll dues: paid through Payroll → Statutory Reports (compliance-calendar.ts reads those payments). */
  paid?: { duePaise: number; paidPaise: number; payments: { on: string; reference: string | null; amountPaise: number }[] } | null;
}

/** Marked done by Payroll's own records, not by hand: corrected there, not here. */
const PAYROLL_BY = 'Payroll → Statutory Reports';
const fromPayroll = (r: Row) => r.done?.by === PAYROLL_BY;
/** A payment is paid, a return is filed. */
const doneLabel = (r: Row, st: Status) => (fromPayroll(r) && r.key !== 'salary-tds-return' ? (st === 'late' ? 'Paid late' : 'Paid') : LOOK[st].label);
const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

const AREAS: [string, string][] = [['gst', 'GST'], ['tds', 'TDS / TCS'], ['payroll', 'Payroll (PF, ESI, PT)'], ['income_tax', 'Income tax'], ['roc', 'ROC'], ['msme', 'MSME']];
const MON = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
const LOOK: Record<Status, { label: string; cls: string }> = {
  done: { label: 'Filed', cls: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  late: { label: 'Filed late', cls: 'bg-amber-50 text-amber-800 border-amber-300' },
  overdue: { label: 'Overdue', cls: 'bg-red-50 text-red-700 border-red-200' },
  due_soon: { label: 'Due soon', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  upcoming: { label: 'Upcoming', cls: 'bg-muted/40 text-muted-foreground border-border' },
};
const statusOf = (r: Row): Status => (r.done ? (r.done.on > r.dueDate ? 'late' : 'done') : r.status);
const isFilingReturn = (k: string): k is FilingReturn => (FILING_RETURNS as string[]).includes(k);

const fyStart = () => {
  const d = new Date();
  return d.getMonth() < 3 ? d.getFullYear() - 1 : d.getFullYear();
};
const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Which of the twelve columns (April = 0) a period belongs to: a quarter or a year in its last month. */
function column(period: string, start: number): number | null {
  let m = /^(\d{4})-(\d{2})$/.exec(period);
  if (m) {
    const idx = (Number(m[1]) - start) * 12 + Number(m[2]) - 4;
    return idx >= 0 && idx < 12 ? idx : null;
  }
  m = /^(\d{4})-Q([1-4])$/.exec(period);
  if (m) return Number(m[1]) === start ? Number(m[2]) * 3 - 1 : null;
  m = /^(\d{4})-H([12])$/.exec(period);
  if (m) return Number(m[1]) === start ? Number(m[2]) * 6 - 1 : null;
  m = /^(\d{4})-I([1-4])$/.exec(period);
  if (m) return Number(m[1]) === start ? [2, 5, 8, 11][Number(m[2]) - 1] : null;
  if (/^\d{4}$/.test(period)) return Number(period) === start ? 11 : null;
  return null;
}

const shortDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
const longDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

/** Marking done any obligation that is not a GST return: the date and its reference. */
function OtherDialog({ row, onClose, onDone }: { row: Row; onClose: () => void; onDone: () => void }) {
  const canEdit = usePermission('gst', 'edit');
  const [editing, setEditing] = useState(!row.done);
  const [doneOn, setDoneOn] = useState(row.done?.on ?? localDay());
  const [reference, setReference] = useState(row.done?.reference ?? '');
  const [busy, setBusy] = useState(false);
  const del = useConfirmDelete();
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/api/compliance-calendar', { action: 'done', key: row.key, period: row.period, doneOn, reference: reference.trim() || null });
      toast.success(`${row.title} for ${row.periodLabel} marked done`);
      onDone();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-md" data-slot="return-cell-dialog">
        <DialogHeader>
          <DialogTitle>{row.title} · {row.periodLabel}</DialogTitle>
          <DialogDescription>Due {longDate(row.dueDate)}.{row.done ? ` Done on ${longDate(row.done.on)}${row.done.reference ? ` · ${row.done.reference}` : ''}${row.done.by ? ` · marked by ${row.done.by}` : ''}.` : ' Not done yet.'}</DialogDescription>
        </DialogHeader>
        {(row.paid?.payments.length ?? 0) > 0 && (
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-[12px]" data-slot="return-cell-payments">
            <p className="font-medium">Paid through Payroll → Statutory Reports → Dues &amp; Payments: {rupees(row.paid!.paidPaise)} of {rupees(row.paid!.duePaise)}</p>
            <ul className="mt-1 list-disc pl-4 text-muted-foreground">
              {row.paid!.payments.map((x, i) => <li key={i}>{longDate(x.on)} · {rupees(x.amountPaise)}{x.reference ? ` · ${x.reference}` : ''}</li>)}
            </ul>
          </div>
        )}
        {row.done && fromPayroll(row) ? (
          <p className="text-[12px] text-muted-foreground" data-slot="return-cell-from-payroll">
            Marked from Payroll&apos;s own record. To correct it, edit or delete the payment (or the 24Q receipt) in Payroll → Statutory Reports.
          </p>
        ) : editing && canEdit ? (
          <div className="space-y-3">
            <div className="space-y-1.5"><Label htmlFor="other-on">Done on</Label><Input id="other-on" type="date" value={doneOn} max={localDay()} onChange={(e) => setDoneOn(e.target.value)} /></div>
            <div className="space-y-1.5"><Label htmlFor="other-ref">Reference (ARN, challan, TRRN, SRN)</Label><Input id="other-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} /></div>
          </div>
        ) : row.done && canEdit ? (
          <div className="flex gap-1.5">
            <EditButton onClick={() => setEditing(true)} />
            <DeleteButton onClick={() => del.ask({
              title: `Delete the done mark on ${row.title} for ${row.periodLabel}?`, description: 'It shows as not done again. Nothing outside Rekonza changes.', reason: false,
              run: () => api.post('/api/compliance-calendar', { action: 'undo', key: row.key, period: row.period }), done: 'Mark deleted', onDone,
            })} />
          </div>
        ) : null}
        <DialogFooter>
          {row.href && <Button variant="ghost" asChild><Link href={returnHref(row.href, row.period)}><ExternalLink className="mr-1.5 size-3.5" /> Open</Link></Button>}
          <Button variant="outline" onClick={onClose} disabled={busy}>Close</Button>
          {editing && canEdit && <Button onClick={() => void save()} disabled={busy || !doneOn}>Save</Button>}
        </DialogFooter>
        {del.dialog}
      </DialogContent>
    </Dialog>
  );
}

/** A GST return's cell: the filing bar itself, and the way into the return for that period. */
function GstDialog({ row, onClose, onChange }: { row: Row & { key: FilingReturn }; onClose: () => void; onChange: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl" data-slot="return-cell-dialog">
        <DialogHeader>
          <DialogTitle>{row.title} · {row.periodLabel}</DialogTitle>
          <DialogDescription>Due {longDate(row.dueDate)}. Mark it filed with the date and the ARN the portal gave, or correct or delete that mark.</DialogDescription>
        </DialogHeader>
        <ReturnFilingBar returnType={row.key} period={row.period} title={row.title} onChange={onChange} />
        <DialogFooter>
          {row.href && (
            <Button asChild data-slot="return-cell-open">
              <Link href={returnHref(row.href, row.period)}><ExternalLink className="mr-1.5 size-3.5" /> Open {row.title.split(' ')[0]} for {row.periodLabel}</Link>
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function ReturnStatusPage() {
  const [start, setStart] = useState(fyStart());
  const [areas, setAreas] = useState<string[]>(['gst', 'tds', 'payroll']);
  const [open, setOpen] = useState<Row | null>(null);
  const from = `${start}-04-01`;
  // Returns for the year fall due up to the next December (GSTR-9 by 31 Dec): read a little past March.
  const to = `${start + 1}-12-31`;
  const state = useApi<{ rows: Row[]; profile: { gstTdsDeductor?: boolean; gstEcoOperator?: boolean; registration: string } }>(
    () => api.get('/api/compliance-calendar', { from, to }), [from, to]);

  const grid = useMemo(() => {
    const out = new Map<string, { title: string; area: string; href?: string; cells: (Row | null)[] }>();
    for (const r of state.data?.rows ?? []) {
      if (!areas.includes(r.area)) continue;
      const col = column(r.period, start);
      if (col === null) continue;
      const g = out.get(r.key) ?? { title: r.title, area: r.area, href: r.href, cells: Array<Row | null>(12).fill(null) };
      g.cells[col] = r;
      out.set(r.key, g);
    }
    return [...out.entries()].sort((a, b) => AREAS.findIndex(([k]) => k === a[1].area) - AREAS.findIndex(([k]) => k === b[1].area) || a[1].title.localeCompare(b[1].title));
  }, [state.data, areas, start]);

  const all = grid.flatMap(([, g]) => g.cells.filter((c): c is Row => !!c));
  const count = (s: Status) => all.filter((c) => statusOf(c) === s).length;

  const exportIt = () => downloadCsv(`return-status-${start}-${String((start + 1) % 100).padStart(2, '0')}.csv`, [
    ['Return', 'Period', 'Due date', 'Status', 'Filed on', 'Reference / ARN', 'Marked by'],
    ...all.map((c) => [c.title, c.periodLabel, c.dueDate, doneLabel(c, statusOf(c)), c.done?.on ?? '', c.done?.reference ?? '', c.done?.by ?? '']),
  ]);
  const profile = state.data?.profile;

  return (
    <>
      <PageHeader
        title="Return Status"
        description="Every return of the year in one grid: filed (with its date and ARN), filed late, overdue, due soon or upcoming. Click a cell to mark it filed, correct or delete the mark, see the late fee and interest, or open the return for that period."
        actions={
          <>
            <select value={start} onChange={(e) => setStart(Number(e.target.value))} className="h-8 rounded-[3px] border bg-background px-2 text-sm" aria-label="Financial year" data-slot="return-status-fy">
              {[fyStart(), fyStart() - 1, fyStart() - 2].map((y) => <option key={y} value={y}>FY {y}-{String((y + 1) % 100).padStart(2, '0')}</option>)}
            </select>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={exportIt} disabled={!all.length} data-slot="return-status-export"><Download className="size-3.5" /> Export</Button>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2" data-slot="return-status-areas">
        {AREAS.map(([k, l]) => (
          <button key={k} type="button" onClick={() => setAreas((a) => (a.includes(k) ? a.filter((x) => x !== k) : [...a, k]))}
            className={cn('rounded-full border px-3 py-1 text-xs', areas.includes(k) ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground')} aria-pressed={areas.includes(k)}>
            {l}
          </button>
        ))}
        <span className="ml-auto flex gap-3 text-xs text-muted-foreground" data-slot="return-status-counts">
          <span><b className="text-emerald-700">{count('done')}</b> filed</span>
          <span><b className="text-amber-700">{count('late')}</b> filed late</span>
          <span><b className="text-red-700">{count('overdue')}</b> overdue</span>
          <span><b className="text-amber-700">{count('due_soon')}</b> due soon</span>
          <span><b>{count('upcoming')}</b> upcoming</span>
        </span>
      </div>
      {profile && profile.registration === 'regular' && (!profile.gstTdsDeductor || !profile.gstEcoOperator) && (
        <p className="text-xs text-muted-foreground" data-slot="return-status-roles">
          {!profile.gstTdsDeductor && 'GSTR-7 (GST TDS, for a government department or notified body deducting under section 51)'}
          {!profile.gstTdsDeductor && !profile.gstEcoOperator && ' and '}
          {!profile.gstEcoOperator && 'GSTR-8 (an e-commerce operator collecting TCS under section 52)'}
          {' '}appear here once the role is turned on in <Link href="/settings?tab=statutory" className="text-primary hover:underline">Settings → Statutory → GST roles</Link>.
        </p>
      )}
      <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
        {() => grid.length === 0 ? (
          <Card className="p-6 text-sm text-muted-foreground">No returns for these areas in this year. Check the GST registration and statutory details in Settings.</Card>
        ) : (
          <Card className="overflow-hidden p-0">
            <div className="overflow-x-auto thin-scroll">
              <table className="w-full min-w-[1100px] text-xs" data-slot="return-status-grid">
                <thead>
                  <tr className="border-b bg-muted/50 text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="sticky left-0 bg-muted/50 px-3 py-2 text-left font-semibold">Return</th>
                    {MON.map((m, i) => <th key={m} className="px-1.5 py-2 text-center font-semibold">{m} {i < 9 ? String(start).slice(2) : String(start + 1).slice(2)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {grid.map(([key, g]) => (
                    <tr key={key} className="border-b last:border-0" data-slot={`return-row-${key}`}>
                      <td className="sticky left-0 whitespace-nowrap bg-background px-3 py-2 font-medium">
                        {g.href ? <Link href={g.href} className="hover:underline">{g.title}</Link> : g.title}
                      </td>
                      {g.cells.map((c, i) => {
                        if (!c) return <td key={i} className="px-1 py-1.5 text-center"><span className="text-muted-foreground/40">—</span></td>;
                        const st = statusOf(c);
                        return (
                          <td key={i} className="px-1 py-1.5 text-center">
                            <button type="button" onClick={() => setOpen(c)}
                              title={`${c.title} · ${c.periodLabel} · due ${c.dueDate}${c.done ? ` · filed ${c.done.on}${c.done.reference ? ` · ${c.done.reference}` : ''}` : ''}`}
                              className={cn('inline-flex min-w-[64px] flex-col items-center rounded-[3px] border px-1 py-0.5 leading-tight hover:ring-1 hover:ring-primary/40', LOOK[st].cls)}
                              data-slot="return-cell" data-status={st} data-key={c.key} data-period={c.period}>
                              <span className="flex items-center gap-0.5 font-medium">{(st === 'done' || st === 'late') && <CheckCircle2 className="size-3" />}{doneLabel(c, st)}</span>
                              <span className="text-[10px] opacity-80">{c.done ? shortDate(c.done.on) : `due ${shortDate(c.dueDate)}`}</span>
                              {c.done?.reference && <span className="max-w-[80px] truncate text-[9px] opacity-70">{c.done.reference}</span>}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </AsyncPage>
      {open && (isFilingReturn(open.key)
        ? <GstDialog row={open as Row & { key: FilingReturn }} onClose={() => setOpen(null)} onChange={() => void state.refetch()} />
        : <OtherDialog row={open} onClose={() => setOpen(null)} onDone={() => { setOpen(null); void state.refetch(); }} />)}
    </>
  );
}
