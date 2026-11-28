'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Budgets, as Zoho Books has them: named budgets for a financial year
// ("Original", "Revised"), each entered month by month, by quarter, by half
// year or for the year, for the whole business or one branch, cost centre or
// project. Each opens its Budget vs Actuals report; each can be edited,
// cloned and deleted.
//
// The Costing tab sets each cost centre's budget against what its own lines
// show for the year, so "Budgeting & Costing" is read in one place.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { BarChart3, Copy, Plus, Star } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { EmptyState } from '@/components/shared/empty-state';
import { Money } from '@/components/shared/money';
import { Field } from '@/components/shared/form-bits';
import { EditButton, DeleteButton, useConfirmDelete } from '@/components/shared/row-actions';
import { budgetPlans, type BudgetPlanSummary, type BudgetVarianceCell } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';

const PERIOD_LABEL: Record<BudgetPlanSummary['period'], string> = { monthly: 'Monthly', quarterly: 'Quarterly', half_yearly: 'Half-yearly', yearly: 'Yearly' };
const currentFy = () => {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const y = Number(d.slice(0, 4)) - (Number(d.slice(5, 7)) < 4 ? 1 : 0);
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
};
const scopeOf = (p: Pick<BudgetPlanSummary, 'branchName' | 'costCentreName' | 'projectName'>) =>
  p.costCentreName ? `Cost centre: ${p.costCentreName}` : p.projectName ? `Project: ${p.projectName}` : p.branchName ? `Branch: ${p.branchName}` : 'Whole business';

export default function BudgetsPage() {
  return <Suspense fallback={<LoadingRows rows={6} />}><Budgets /></Suspense>;
}

function Budgets() {
  const router = useRouter();
  const params = useSearchParams();
  const [fy, setFy] = useState(params.get('fy') ?? currentFy());
  const [tab, setTab] = useState<'budgets' | 'costing'>(params.get('tab') === 'costing' ? 'costing' : 'budgets');
  const canCreate = usePermission('accountant', 'create');
  const canEdit = usePermission('accountant', 'edit');
  const canDelete = usePermission('accountant', 'void');
  const state = useApi(() => budgetPlans.list(fy), [fy]);
  const costing = useApi(() => (tab === 'costing' ? budgetPlans.costing(fy) : Promise.resolve(null)), [fy, tab]);
  const del = useConfirmDelete();
  const [cloning, setCloning] = useState<BudgetPlanSummary | null>(null);
  const [cloneName, setCloneName] = useState('');
  const [cloneFy, setCloneFy] = useState('');
  const [clonePct, setClonePct] = useState('0');
  const [busy, setBusy] = useState(false);

  const doClone = async () => {
    if (!cloning) return;
    setBusy(true);
    try {
      const r = await budgetPlans.clone(cloning.id, cloneName.trim(), cloneFy || undefined, Number(clonePct) || 0);
      toast.success(`Cloned as ${cloneName.trim()}`);
      setCloning(null);
      if (cloneFy && cloneFy !== fy) setFy(cloneFy); else state.refetch();
      router.push(`/accountant/budgets/edit?id=${r.id}`);
    } catch (e) {
      toast.error('Not cloned', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Budgets"
        description="Plan income and expenses for a financial year, month by month, by quarter, by half year or for the year, and compare them with what the books show."
        actions={(
          <div className="flex flex-wrap items-end gap-2">
            <label className="space-y-1 text-[11px] font-medium text-muted-foreground">
              <span className="block">Financial year</span>
              <select value={fy} onChange={(e) => setFy(e.target.value)} className="h-9 rounded-md border bg-background px-2 text-sm" data-slot="budget-fy">
                {[...new Set([fy, ...(state.data?.years ?? [])])].sort().reverse().map((y) => <option key={y} value={y}>FY {y}</option>)}
              </select>
            </label>
            <Button size="sm" variant="outline" asChild className="gap-1.5"><Link href="/reports/budget-vs-actuals"><BarChart3 className="size-4" /> Budget vs Actuals</Link></Button>
            {canCreate && <Button size="sm" className="gap-1.5" asChild><Link href={`/accountant/budgets/edit?fy=${fy}`} data-slot="new-budget"><Plus className="size-4" /> New Budget</Link></Button>}
          </div>
        )}
      />
      <div role="tablist" className="inline-flex gap-1 rounded-lg border bg-muted/40 p-1">
        {(['budgets', 'costing'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => setTab(t)} data-slot={`budget-tab-${t}`}
            className={cn('rounded-md px-3 py-1.5 text-xs font-medium', tab === t ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
            {t === 'budgets' ? 'Budgets' : 'Cost centre costing'}
          </button>
        ))}
      </div>

      {tab === 'budgets' ? (
        <AsyncPage state={state} loading={<LoadingRows rows={6} />}>
          {(d) => d.plans.length === 0 ? (
            <EmptyState icon={BarChart3} title={`No budgets for FY ${fy} yet`}
              description="New Budget → name it, choose monthly, quarterly, half-yearly or yearly, add the income and expense accounts, and enter the amounts (or fill them from last year's actuals). Then open Budget vs Actuals to see the variance."
              action={canCreate ? <Button size="sm" asChild><Link href={`/accountant/budgets/edit?fy=${fy}`}><Plus className="size-4" /> New Budget</Link></Button> : undefined} />
          ) : (
            <Card className="gap-0 overflow-hidden p-0">
              <table className="w-full text-sm" data-slot="budget-list">
                <thead>
                  <tr className="border-b bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 font-semibold">Name</th>
                    <th className="px-4 py-2.5 font-semibold">Period</th>
                    <th className="px-4 py-2.5 font-semibold">For</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Accounts</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Income budget</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Expense budget</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Net</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {d.plans.map((p) => (
                    <tr key={p.id} className="border-b last:border-0 hover:bg-accent/40" data-slot="budget-row">
                      <td className="px-4 py-2.5">
                        <Link href={`/reports/budget-vs-actuals?plan=${p.id}`} className="font-medium hover:underline">{p.name}</Link>
                        {p.isPrimary && <Badge variant="outline" className="ml-2 gap-1 text-[10px]" title="The year's main budget: what the assistant and the yearly view read"><Star className="size-2.5" /> Primary</Badge>}
                        {p.notes && <p className="text-xs text-muted-foreground">{p.notes}</p>}
                      </td>
                      <td className="px-4 py-2.5">{PERIOD_LABEL[p.period]}</td>
                      <td className="px-4 py-2.5 text-xs">{scopeOf(p)}{p.includeBalanceSheet ? ' · with balance sheet' : ''}</td>
                      <td className="px-4 py-2.5 text-right">{p.accounts}</td>
                      <td className="px-4 py-2.5 text-right"><Money value={p.incomePaise} /></td>
                      <td className="px-4 py-2.5 text-right"><Money value={p.expensePaise} /></td>
                      <td className="px-4 py-2.5 text-right font-medium"><Money value={p.incomePaise - p.expensePaise} /></td>
                      <td className="px-4 py-2.5">
                        <div className="flex justify-end gap-1">
                          <Button size="xs" variant="outline" asChild><Link href={`/reports/budget-vs-actuals?plan=${p.id}`} data-slot="budget-report">Budget vs Actuals</Link></Button>
                          {canEdit && <EditButton onClick={() => router.push(`/accountant/budgets/edit?id=${p.id}`)} slot="budget-edit" />}
                          {canCreate && (
                            <Button size="xs" variant="outline" className="gap-1" data-slot="budget-clone"
                              onClick={() => { setCloning(p); setCloneName(`${p.name} (copy)`); setCloneFy(p.fyLabel); setClonePct('0'); }}>
                              <Copy className="size-3" /> Clone
                            </Button>
                          )}
                          {canDelete && (
                            <DeleteButton slot="budget-delete" onClick={() => del.ask({
                              title: `Delete the budget "${p.name}"?`,
                              description: 'The plan and its amounts go; the books do not move. The audit trail keeps the record of it.',
                              run: (reason) => budgetPlans.remove(p.id, reason),
                              done: `Deleted ${p.name}`,
                              onDone: () => state.refetch(),
                            })} />
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </AsyncPage>
      ) : (
        <AsyncPage state={costing} loading={<LoadingRows rows={4} />}>
          {(c) => !c || c.centres.length === 0 ? (
            <EmptyState icon={BarChart3} title="No cost centre budgets or costs this year"
              description="New Budget → For: choose a cost centre, and enter its income and expense budget. Costs posted to a cost centre show here against it." />
          ) : (
            <Card className="gap-0 overflow-x-auto p-0">
              <table className="w-full text-sm" data-slot="costing-table">
                <thead>
                  <tr className="border-b bg-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 text-left font-semibold">Cost centre</th>
                    {['Income', 'Expense', 'Net'].map((h) => <th key={h} colSpan={3} className="border-l px-3 py-2.5 text-center font-semibold">{h}: budget · actual · variance</th>)}
                  </tr>
                </thead>
                <tbody>
                  {c.centres.map((r) => (
                    <tr key={r.costCentreId} className="border-b last:border-0" data-slot="costing-row">
                      <td className="px-4 py-2.5">
                        <span className="font-medium">{r.code} {r.name}</span>
                        <p className="text-xs text-muted-foreground">{r.planId ? <Link href={`/reports/budget-vs-actuals?plan=${r.planId}`} className="text-primary hover:underline">{r.planName}</Link> : 'No budget set'}</p>
                      </td>
                      {[r.income, r.expense, r.net].map((x, i) => <CostCells key={i} c={x} />)}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="border-t px-4 py-2 text-xs text-muted-foreground">Actuals are the journal lines posted to each cost centre from 1 April to {c.to}; the budget is the cost centre&apos;s budget to the same date.</p>
            </Card>
          )}
        </AsyncPage>
      )}

      <Dialog open={!!cloning} onOpenChange={(o) => !o && setCloning(null)}>
        <DialogContent data-slot="clone-dialog">
          <DialogHeader>
            <DialogTitle>Clone {cloning?.name}</DialogTitle>
            <DialogDescription>A copy with every amount, under a new name — for a revised budget this year, or next year&apos;s starting point.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="New name" required><Input value={cloneName} onChange={(e) => setCloneName(e.target.value)} data-slot="clone-name" /></Field>
            <Field label="Financial year">
              <select value={cloneFy} onChange={(e) => setCloneFy(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                {[...new Set([cloneFy, ...(state.data?.years ?? [])])].sort().reverse().map((y) => <option key={y} value={y}>FY {y}</option>)}
              </select>
            </Field>
            <Field label="Change every amount by %"><Input type="number" value={clonePct} onChange={(e) => setClonePct(e.target.value)} data-slot="clone-pct" /></Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCloning(null)}>Cancel</Button>
            <Button disabled={busy || cloneName.trim().length < 2} onClick={() => void doClone()} data-slot="clone-go">Clone</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {del.dialog}
    </>
  );
}

function CostCells({ c }: { c: BudgetVarianceCell }) {
  return (
    <>
      <td className="border-l px-3 py-2.5 text-right"><Money value={c.budgetPaise} /></td>
      <td className="px-3 py-2.5 text-right"><Money value={c.actualPaise} /></td>
      <td className={cn('px-3 py-2.5 text-right font-medium', c.favourable === true && 'text-emerald-700 dark:text-emerald-400', c.favourable === false && 'text-destructive')}>
        <Money value={c.variancePaise} />{c.favourable !== null && <span className="ml-1 text-[10px]">{c.favourable ? 'F' : 'U'}</span>}
      </td>
    </>
  );
}
