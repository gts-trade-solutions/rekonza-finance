'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Return status: every return of the year on one page, filed or not.
//
// The compliance calendar lists obligations by due date; an auditor asks a
// different question — "which returns were filed for which period, and which
// were not?" — and wants the answer as a grid: each return a row, each month a
// column, the cell saying Filed (with its date and ARN), Overdue, Due soon or
// Upcoming. Quarterly returns sit in their quarter's last month, annual ones
// in March. The same obligations and filings feed both screens.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { CheckCircle2, Download } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { downloadCsv } from '@/components/shared/report-shell';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { cn } from '@/lib/utils';

type Status = 'done' | 'overdue' | 'due_soon' | 'upcoming';
interface Row {
  key: string; period: string; periodLabel: string; title: string; area: string; dueDate: string; href?: string;
  status: Status; daysLeft: number; done: { on: string; reference: string | null; by: string | null } | null;
}

const AREAS: [string, string][] = [['gst', 'GST'], ['tds', 'TDS / TCS'], ['payroll', 'Payroll (PF, ESI, PT)'], ['income_tax', 'Income tax'], ['roc', 'ROC'], ['msme', 'MSME']];
const MON = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
const LOOK: Record<Status, { label: string; cls: string }> = {
  done: { label: 'Filed', cls: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  overdue: { label: 'Overdue', cls: 'bg-red-50 text-red-700 border-red-200' },
  due_soon: { label: 'Due soon', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  upcoming: { label: 'Upcoming', cls: 'bg-muted/40 text-muted-foreground border-border' },
};

const fyStart = () => {
  const d = new Date();
  return d.getMonth() < 3 ? d.getFullYear() - 1 : d.getFullYear();
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

export default function ReturnStatusPage() {
  const [start, setStart] = useState(fyStart());
  const [areas, setAreas] = useState<string[]>(['gst', 'tds', 'payroll']);
  const from = `${start}-04-01`;
  // Returns for the year fall due up to the next November (GSTR-9 by 31 Dec): read a little past March.
  const to = `${start + 1}-12-31`;
  const state = useApi<{ rows: Row[] }>(() => api.get('/api/compliance-calendar', { from, to }), [from, to]);

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
  const count = (s: Status) => all.filter((c) => c.status === s).length;

  const exportIt = () => downloadCsv(`return-status-${start}-${String((start + 1) % 100).padStart(2, '0')}.csv`, [
    ['Return', 'Period', 'Due date', 'Status', 'Filed on', 'Reference / ARN', 'Marked by'],
    ...all.map((c) => [c.title, c.periodLabel, c.dueDate, LOOK[c.status].label, c.done?.on ?? '', c.done?.reference ?? '', c.done?.by ?? '']),
  ]);

  return (
    <>
      <PageHeader
        title="Return Status"
        description="Every return of the year in one grid: filed with its date and ARN, overdue, due soon or upcoming. Filings are marked on the Compliance Calendar, or by filing through Rekonza."
        actions={
          <>
            <select value={start} onChange={(e) => setStart(Number(e.target.value))} className="h-8 rounded-[3px] border bg-background px-2 text-sm" aria-label="Financial year">
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
        <span className="ml-auto flex gap-3 text-xs text-muted-foreground">
          <span><b className="text-emerald-700">{count('done')}</b> filed</span>
          <span><b className="text-red-700">{count('overdue')}</b> overdue</span>
          <span><b className="text-amber-700">{count('due_soon')}</b> due soon</span>
          <span><b>{count('upcoming')}</b> upcoming</span>
        </span>
      </div>
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
                      {g.cells.map((c, i) => (
                        <td key={i} className="px-1 py-1.5 text-center">
                          {c ? (
                            <span title={`${c.title} · ${c.periodLabel} · due ${c.dueDate}${c.done ? ` · filed ${c.done.on}${c.done.reference ? ` · ${c.done.reference}` : ''}` : ''}`}
                              className={cn('inline-flex min-w-[64px] flex-col items-center rounded-[3px] border px-1 py-0.5 leading-tight', LOOK[c.status].cls)} data-slot="return-cell" data-status={c.status}>
                              <span className="flex items-center gap-0.5 font-medium">{c.status === 'done' && <CheckCircle2 className="size-3" />}{LOOK[c.status].label}</span>
                              <span className="text-[10px] opacity-80">{c.done ? shortDate(c.done.on) : `due ${shortDate(c.dueDate)}`}</span>
                              {c.done?.reference && <span className="max-w-[80px] truncate text-[9px] opacity-70">{c.done.reference}</span>}
                            </span>
                          ) : <span className="text-muted-foreground/40">—</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </AsyncPage>
    </>
  );
}
