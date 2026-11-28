'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Budget vs Actuals, as Zoho Books lays it out: for one budget, each account
// by month (or quarter, half year, year) with the budget, the actual from the
// journal, the variance in rupees and per cent, and whether it is favourable —
// income above budget is, an expense above budget is not. Income, cost of
// goods sold, gross profit, expenses and net profit are totalled; a line whose
// variance passes the threshold is highlighted; an actual opens the account's
// ledger for that column, narrowed to the budget's branch, cost centre or
// project. Exports carry the same heading the screen shows.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Fragment, Suspense, useMemo, useState } from 'react';
import { ArrowLeft, BarChart3, Download, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { EmptyState } from '@/components/shared/empty-state';
import { Money } from '@/components/shared/money';
import { downloadCsv } from '@/components/shared/report-shell';
import { budgetPlans, type BudgetColumnMode, type BudgetVarianceCell, type BudgetVarianceReport } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { ledgerHref } from '@/lib/source-links';
import { toRupees } from '@/lib/money';
import { downloadWorkbook } from '@/lib/xlsx';
import { downloadPdf, istNow, pdfTable, type PdfRow } from '@/lib/pdf';
import { allowOutput, printPage } from '@/lib/output-guard';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { useDocumentTitle } from '@/lib/use-document-title';

type Part = 'budget' | 'actual' | 'variance' | 'pct';
const PART_LABEL: Record<Part, string> = { budget: 'Budget', actual: 'Actual', variance: 'Variance ₹', pct: 'Variance %' };
const COLUMN_LABEL: Record<BudgetColumnMode, string> = { month: 'Month', quarter: 'Quarter', half: 'Half year', year: 'Year' };
const todayIst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const fmtPct = (c: BudgetVarianceCell) => (c.variancePct === null ? '—' : `${c.variancePct > 0 ? '+' : ''}${c.variancePct.toFixed(1)}%`);
const fu = (c: BudgetVarianceCell) => (c.favourable === null ? '' : c.favourable ? 'F' : 'U');

export default function BudgetVsActualsPage() {
  return <Suspense fallback={<LoadingRows rows={10} />}><Report /></Suspense>;
}

function Report() {
  const router = useRouter();
  const params = useSearchParams();
  const org = useAppStore((s) => s.org?.name ?? '');
  const plans = useApi(() => budgetPlans.list(), []);
  const chosen = params.get('plan') ?? plans.data?.plans.find((p) => p.isPrimary)?.id ?? plans.data?.plans[0]?.id ?? null;
  const [columns, setColumns] = useState<BudgetColumnMode | ''>('');
  const [upto, setUpto] = useState('');
  const [threshold, setThreshold] = useState('10');
  const [parts, setParts] = useState<Set<Part>>(new Set(['budget', 'actual', 'variance', 'pct']));
  const state = useApi(
    () => (chosen ? budgetPlans.variance(chosen, { columns: columns || undefined, upto: upto || undefined, threshold: Number(threshold) || 0 }) : Promise.resolve(null)),
    [chosen, columns, upto, threshold],
  );
  const shown = (['budget', 'actual', 'variance', 'pct'] as Part[]).filter((p) => parts.has(p));
  useDocumentTitle(state.data ? `Budget vs Actuals ${state.data.plan.name} FY ${state.data.plan.fyLabel}` : 'Budget vs Actuals');

  const heading = (d: BudgetVarianceReport) => [
    `Budget: ${d.plan.name} · FY ${d.plan.fyLabel} · entered ${d.plan.period.replace('_', '-')}`,
    `For: ${d.plan.costCentreName ? `cost centre ${d.plan.costCentreName}` : d.plan.projectName ? `project ${d.plan.projectName}` : d.plan.branchName ? `branch ${d.plan.branchName}` : 'the whole business'}`,
    `Columns: by ${COLUMN_LABEL[(columns || defaultMode(d)) as BudgetColumnMode].toLowerCase()} · actuals up to ${d.upto} · highlighted where the variance exceeds ${d.thresholdPct}%`,
    'Variance is actual less budget. F favourable (income above, or expense below, budget); U unfavourable.',
  ];
  const flat = (d: BudgetVarianceReport) => {
    const head = ['Account', ...d.columns.flatMap((c) => shown.map((p) => `${c.label} ${PART_LABEL[p]}`)), ...shown.map((p) => `Total ${PART_LABEL[p]}`), 'F/U'];
    const vals = (c: BudgetVarianceCell) => shown.map((p) => (p === 'budget' ? String(toRupees(c.budgetPaise)) : p === 'actual' ? String(toRupees(c.actualPaise)) : p === 'variance' ? String(toRupees(c.variancePaise)) : fmtPct(c)));
    const rows: { cells: string[]; style: PdfRow['style'] }[] = [];
    for (const s of d.sections) {
      rows.push({ cells: [s.label.toUpperCase()], style: 'heading' });
      for (const r of s.rows) rows.push({ cells: [`${r.code ? `${r.code} ` : ''}${r.name}${r.budgeted || r.computed ? '' : ' (not budgeted)'}`, ...r.cells.flatMap(vals), ...vals(r.total), fu(r.total)], style: r.total.flagged ? 'highlight' : 'normal' });
      rows.push({ cells: [`Total ${s.label}`, ...s.total.cells.flatMap(vals), ...vals(s.total.total), fu(s.total.total)], style: 'total' });
    }
    for (const x of d.summary) rows.push({ cells: [x.label, ...x.cells.flatMap(vals), ...vals(x.total), fu(x.total)], style: 'total' });
    return { head, rows };
  };
  const exportAs = (as: 'xlsx' | 'csv' | 'pdf') => {
    const d = state.data;
    if (!d) return;
    const name = `Budget vs Actuals - ${d.plan.name} - FY ${d.plan.fyLabel}`;
    const { head, rows } = flat(d);
    const top = [[`${org} — Budget vs Actuals`], ...heading(d).map((h) => [h])];
    if (as === 'csv') { downloadCsv(`${name}.csv`, [...top, head, ...rows.map((r) => r.cells)]); return; }
    if (as === 'xlsx') {
      downloadWorkbook(name, [{ name: 'Budget vs Actuals', rows: [head, ...rows.map((r) => r.cells.map((c, i) => (i > 0 && /^-?\d+(\.\d+)?$/.test(c) ? Number(c) : c))), [], ...top] }]);
      return;
    }
    if (!allowOutput('export', name)) return;
    downloadPdf(name, pdfTable({
      title: 'Budget vs Actuals', org, lines: heading(d), landscape: true, fontSize: head.length > 30 ? 5.5 : 7,
      columns: head.map((h, i) => ({ header: h, width: i === 0 ? 4 : 1 })), rows, notes: d.notes, footer: `Exported ${istNow()}`,
    }));
  };

  return (
    <>
      <div className="no-print space-y-4">
        <Button variant="ghost" size="sm" asChild className="-ml-2 gap-1.5"><Link href="/reports"><ArrowLeft className="size-3.5" /> All reports</Link></Button>
        <div className="flex flex-col gap-3 border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Budget vs Actuals</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Each account&apos;s budget against what the books show, period by period, with the variance and whether it is favourable.</p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="space-y-1 text-[11px] font-medium text-muted-foreground">
              <span className="block">Budget</span>
              <select value={chosen ?? ''} onChange={(e) => router.replace(`/reports/budget-vs-actuals?plan=${e.target.value}`)} className="h-9 max-w-64 rounded-md border bg-background px-2 text-sm" data-slot="bva-plan">
                {(plans.data?.plans ?? []).map((p) => <option key={p.id} value={p.id}>FY {p.fyLabel} · {p.name}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-[11px] font-medium text-muted-foreground">
              <span className="block">Columns</span>
              <select value={columns} onChange={(e) => setColumns(e.target.value as BudgetColumnMode | '')} className="h-9 rounded-md border bg-background px-2 text-sm" data-slot="bva-columns">
                <option value="">As entered</option>
                {(Object.keys(COLUMN_LABEL) as BudgetColumnMode[]).map((k) => <option key={k} value={k}>By {COLUMN_LABEL[k].toLowerCase()}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-[11px] font-medium text-muted-foreground">
              <span className="block">Actuals up to</span>
              <div className="flex gap-1">
                <Input type="date" value={upto} onChange={(e) => setUpto(e.target.value)} className="h-9 w-40" data-slot="bva-upto" />
                <Button size="sm" variant="outline" className="h-9" onClick={() => setUpto(todayIst())}>Year to date</Button>
              </div>
            </label>
            <label className="space-y-1 text-[11px] font-medium text-muted-foreground">
              <span className="block">Highlight beyond %</span>
              <Input type="number" value={threshold} onChange={(e) => setThreshold(e.target.value)} className="h-9 w-20" data-slot="bva-threshold" />
            </label>
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-muted" data-slot="bva-export"><Download className="size-3.5" /> Export</DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => exportAs('xlsx')}>Excel (.xlsx)</DropdownMenuItem>
                <DropdownMenuItem onClick={() => exportAs('csv')}>CSV</DropdownMenuItem>
                <DropdownMenuItem onClick={() => exportAs('pdf')} data-slot="bva-export-pdf">PDF</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="outline" size="sm" onClick={() => printPage()} className="gap-1.5"><Printer className="size-3.5" /> Print</Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs" data-slot="bva-show">
          <span className="font-medium text-muted-foreground">Show columns:</span>
          {(Object.keys(PART_LABEL) as Part[]).map((p) => (
            <label key={p} className="flex items-center gap-1.5">
              <input type="checkbox" checked={parts.has(p)} onChange={(e) => setParts((s) => { const x = new Set(s); if (e.target.checked) x.add(p); else if (x.size > 1) x.delete(p); return x; })} /> {PART_LABEL[p]}
            </label>
          ))}
        </div>
      </div>

      {plans.data && plans.data.plans.length === 0 ? (
        <EmptyState icon={BarChart3} title="No budgets yet"
          description="Accountant → Budgets → New Budget: name it, choose the period, add the income and expense accounts and their amounts. Its Budget vs Actuals opens here."
          action={<Button size="sm" asChild><Link href="/accountant/budgets/edit">New Budget</Link></Button>} />
      ) : (
        <AsyncPage state={state} loading={<LoadingRows rows={10} />}>
          {(d) => d && <Table d={d} shown={shown} org={org} heading={heading(d)} />}
        </AsyncPage>
      )}
    </>
  );
}

const defaultMode = (d: BudgetVarianceReport): BudgetColumnMode => (d.plan.period === 'monthly' ? 'month' : d.plan.period === 'quarterly' ? 'quarter' : d.plan.period === 'half_yearly' ? 'half' : 'year');

function Table({ d, shown, org, heading }: { d: BudgetVarianceReport; shown: Part[]; org: string; heading: string[] }) {
  const scope = useMemo(() => {
    const q = new URLSearchParams();
    if (d.plan.branchId) q.set('branchId', d.plan.branchId);
    if (d.plan.costCentreId) q.set('costCentreIds', d.plan.costCentreId);
    if (d.plan.projectId) q.set('projectIds', d.plan.projectId);
    const s = q.toString();
    return s ? `&${s}` : '';
  }, [d.plan]);
  const cells = (c: BudgetVarianceCell, link: string | null, strong = false) => shown.map((p) => (
    <td key={p} className={cn('whitespace-nowrap px-2 py-1.5 text-right tabular-nums', c.flagged && 'bg-amber-100/70 dark:bg-amber-500/15', strong && 'font-semibold',
      (p === 'variance' || p === 'pct') && c.favourable === true && 'text-emerald-700 dark:text-emerald-400',
      (p === 'variance' || p === 'pct') && c.favourable === false && 'text-destructive')}
      data-slot={`bva-${p}`}>
      {p === 'budget' && <Money value={c.budgetPaise} />}
      {p === 'actual' && (link ? <Link href={link} className="hover:underline" data-slot="bva-drill">{<Money value={c.actualPaise} />}</Link> : <Money value={c.actualPaise} />)}
      {p === 'variance' && <><Money value={c.variancePaise} />{c.favourable !== null && <span className="ml-1 text-[10px] font-semibold">{fu(c)}</span>}</>}
      {p === 'pct' && fmtPct(c)}
    </td>
  ));
  const cols = 1 + (d.columns.length + 1) * shown.length;
  return (
    <>
      <div className="print-only mb-3 border-b pb-2">
        <p className="text-lg font-bold">{org}</p>
        <p className="text-sm font-semibold">Budget vs Actuals</p>
        {heading.map((h) => <p key={h} className="text-xs">{h}</p>)}
      </div>
      <Card className="space-y-0.5 p-3 text-xs no-print" data-slot="bva-heading">
        {heading.map((h) => <p key={h} className={h.startsWith('Budget:') ? 'text-sm font-medium' : 'text-muted-foreground'}>{h}</p>)}
      </Card>
      <Card className="gap-0 overflow-x-auto p-0">
        <table className="w-full text-[13px]" data-slot="bva-table">
          <thead>
            <tr className="border-b bg-muted/60 text-[11px] uppercase tracking-wide text-muted-foreground">
              <th rowSpan={2} className="sticky left-0 z-10 min-w-56 bg-muted px-3 py-2 text-left font-semibold">Account</th>
              {d.columns.map((c) => <th key={c.key} colSpan={shown.length} className="border-l px-2 py-1.5 text-center font-semibold">{c.label}</th>)}
              <th colSpan={shown.length} className="border-l px-2 py-1.5 text-center font-semibold">Total</th>
            </tr>
            <tr className="border-b bg-muted/40 text-[10px] uppercase text-muted-foreground">
              {[...d.columns, { key: 'total' }].map((c) => shown.map((p, i) => <th key={`${c.key}-${p}`} className={cn('px-2 py-1 text-right font-medium', i === 0 && 'border-l')}>{PART_LABEL[p]}</th>))}
            </tr>
          </thead>
          <tbody>
            {d.sections.map((s) => (
              <Fragment key={s.key}>
                <tr className="rpt-head border-b" data-slot="rpt-heading"><td colSpan={cols} className="sticky left-0 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide">{s.label}</td></tr>
                {s.rows.map((r) => (
                  <tr key={r.accountId} className="rpt-line border-b border-dashed hover:bg-accent/40" data-slot="bva-row">
                    <td className="sticky left-0 z-10 bg-background px-3 py-1.5">
                      {r.code ? <span className="font-mono text-[11px] text-muted-foreground">{r.code} </span> : null}{r.name}
                      {!r.budgeted && !r.computed && <span className="ml-1.5 text-[10px] text-muted-foreground">not budgeted</span>}
                    </td>
                    {r.cells.map((c, i) => <Fragment key={i}>{cells(c, r.computed ? null : `${ledgerHref(r.accountId, d.columns[i].from, d.columns[i].to)}${scope}`)}</Fragment>)}
                    {cells(r.total, r.computed ? null : `${ledgerHref(r.accountId, d.columns[0]?.from ?? d.upto, d.upto)}${scope}`, true)}
                  </tr>
                ))}
                <tr className="rpt-total border-b font-semibold" data-slot="rpt-total">
                  <td className="sticky left-0 z-10 bg-background px-3 py-1.5">Total {s.label}</td>
                  {s.total.cells.map((c, i) => <Fragment key={i}>{cells(c, null, true)}</Fragment>)}
                  {cells(s.total.total, null, true)}
                </tr>
              </Fragment>
            ))}
            {d.summary.map((x) => (
              <tr key={x.key} className={cn('border-y-2', x.key === 'net' ? 'rpt-result-strong' : 'rpt-result')} data-slot={`bva-${x.key}`}>
                <td className="sticky left-0 z-10 bg-background px-3 py-2 font-semibold">{x.label}</td>
                {x.cells.map((c, i) => <Fragment key={i}>{cells(c, null, true)}</Fragment>)}
                {cells(x.total, null, true)}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {d.notes.map((n) => <p key={n} className="text-xs text-muted-foreground">{n}</p>)}
      <p className="text-xs text-muted-foreground no-print">Click an actual to open the account&apos;s ledger for that period{scope ? ', narrowed to this budget\'s scope' : ''}.</p>
    </>
  );
}
