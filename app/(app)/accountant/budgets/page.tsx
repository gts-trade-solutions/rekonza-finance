'use client';

// Budgets vs actual.
//
// Actual spend is never typed in — it is read from the same journal entries
// that produce the Profit & Loss, matched to the budget by account id. There is
// no category mapping in the middle, so the two sides cannot drift apart.
//
// The comparison runs year-to-date: the year's figure spread evenly over its
// days gives the budget to date, and the variance against that, signed so that
// plus is good (spending under, income over), says favourable or adverse.
// Month by month shows each month's share against its actual. Actuals can be
// narrowed to one branch or one cost centre.

import { Fragment, useEffect, useMemo, useState } from 'react';
import { BarChart3, Download, Plus, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { RowActions, withReason } from '@/components/shared/row-actions';
import { Input } from '@/components/ui/input';
import { BranchSelect, downloadCsv, useBranchName } from '@/components/shared/report-shell';
import {
  accounts as accountsApi, api, budgets as budgetsApi,
  type AccountRow, type BudgetResponse, type BudgetRow,
} from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

/** '2026-27' for any date in the 2026-27 financial year. India runs Apr–Mar. */
function fyLabelFor(date: string): string {
  const [y, m] = date.split('-').map(Number);
  const start = m < 4 ? y - 1 : y;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym: string) => `${MONTH[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;
const rupees = (p: number) => (p / 100).toFixed(2);

/** The years to choose from: two back, this one, the next. */
function yearChoices(today: string): string[] {
  const start = Number(fyLabelFor(today).slice(0, 4));
  return [start + 1, start, start - 1, start - 2].map((y) => `${y}-${String((y + 1) % 100).padStart(2, '0')}`);
}

export default function BudgetsPage() {
  const canEdit = usePermission('accountant', 'edit');
  const canDelete = usePermission('accountant', 'void');
  const todayIso = new Date().toISOString().slice(0, 10);
  const [fy, setFy] = useState(fyLabelFor(todayIso));
  const [asOf, setAsOf] = useState('');
  const [branch, setBranch] = useState('');
  const [centre, setCentre] = useState('');
  const [view, setView] = useState<'ytd' | 'monthly'>('ytd');
  const branchName = useBranchName(branch);

  const state = useApi<BudgetResponse>(
    () => budgetsApi.list({ fy, asOf: asOf || undefined, branchId: branch || undefined, costCentreId: centre || undefined }),
    [fy, asOf, branch, centre],
  );
  // Income and expense accounts: a sales target is a budget too.
  const chart = useApi<{ accounts: AccountRow[] }>(() => accountsApi.list(), []);
  const centres = useApi<{ centres: { id: string; code: string; name: string; isActive?: boolean }[] }>(() => api.get('/api/cost-centres'), []);

  // Edits are held locally until saved, so typing a figure does not fire a
  // request on every keystroke.
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [adding, setAdding] = useState(false);
  const [newAccount, setNewAccount] = useState('');
  const [newAmount, setNewAmount] = useState(0);
  // One line opened to edit: its figure and note.
  const [editing, setEditing] = useState<BudgetRow | null>(null);
  const [editAmount, setEditAmount] = useState(0);
  const [editNotes, setEditNotes] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const saveLine = async () => {
    if (!editing) return;
    if (editAmount <= 0) { toast.error('Enter an amount above zero, or delete the line.'); return; }
    setEditBusy(true);
    try {
      await api.patch('/api/budgets', { fy, accountId: editing.accountId, amountPaise: editAmount, notes: editNotes.trim() || null });
      toast.success(`Budget for ${editing.code} ${editing.name} saved`);
      setEditing(null);
      state.refetch();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setEditBusy(false);
    }
  };

  const save = useApiAction(budgetsApi.set);

  useEffect(() => {
    setDraft({});
  }, [state.data]);

  const dirty = Object.keys(draft).length > 0;
  const elapsed = state.data?.elapsedPct ?? 0;

  const rows = useMemo(() => {
    const base = state.data?.rows ?? [];
    return base.map((r) => {
      const budget = draft[r.accountId] ?? r.budgetPaise;
      // A figure being typed: the to-date share and the variance follow it at once.
      const toDate = budget === r.budgetPaise ? r.budgetToDatePaise : Math.round((budget * elapsed) / 100);
      const variance = r.type === 'income' ? r.actualPaise - toDate : toDate - r.actualPaise;
      return {
        ...r,
        budgetPaise: budget,
        variancePaise: budget - r.actualPaise,
        pct: budget > 0 ? (r.actualPaise / budget) * 100 : 0,
        budgetToDatePaise: toDate,
        varianceToDatePaise: variance,
        variancePct: toDate > 0 ? (variance / toDate) * 100 : 0,
        favourable: variance >= 0,
      };
    }).sort((a, b) => a.code.localeCompare(b.code));
  }, [state.data, draft, elapsed]);

  const totalBudget = rows.reduce((t, r) => t + r.budgetPaise, 0);
  const totalToDate = rows.reduce((t, r) => t + r.budgetToDatePaise, 0);
  const totalVariance = rows.reduce((t, r) => t + r.varianceToDatePaise, 0);
  const spend = rows.filter((r) => r.type !== 'income');
  const earn = rows.filter((r) => r.type === 'income');

  const commit = async () => {
    const entries = Object.entries(draft).map(([accountId, amountPaise]) => ({ accountId, amountPaise }));
    if (!entries.length) return;
    const done = await save.run(fy, entries);
    if (!done) {
      toast.error(save.error ?? 'The budget was not saved');
      return;
    }
    toast.success(`${done.updated} figure(s) saved for FY ${fy}`);
    state.refetch();
  };

  const addAccount = async () => {
    if (!newAccount || newAmount <= 0) {
      toast.error('Pick an account and enter an amount.');
      return;
    }
    const done = await save.run(fy, [{ accountId: newAccount, amountPaise: newAmount }]);
    if (!done) {
      toast.error(save.error ?? 'The budget was not saved');
      return;
    }
    toast.success('Budget added');
    setAdding(false);
    setNewAccount('');
    setNewAmount(0);
    state.refetch();
  };

  const exportIt = () => {
    const d = state.data;
    if (!d) return;
    const head = [`Budget vs Actual, FY ${d.fy}`, `to ${d.asOf}`, branchName ? `Branch: ${branchName}` : '', centre ? `Cost centre: ${centres.data?.centres.find((c) => c.id === centre)?.name ?? centre}` : ''];
    if (view === 'monthly') {
      downloadCsv(`budget-vs-actual-monthly-${d.fy}.csv`, [
        head,
        ['Code', 'Account', 'Type', ...d.months.flatMap((m) => [`${monthLabel(m)} budget`, `${monthLabel(m)} actual`, `${monthLabel(m)} variance`])],
        ...rows.map((r) => [r.code, r.name, r.type, ...r.months.flatMap((m) => [rupees(m.budgetPaise), rupees(m.actualPaise), rupees(m.variancePaise)])]),
      ]);
      return;
    }
    downloadCsv(`budget-vs-actual-${d.fy}.csv`, [
      head,
      ['Code', 'Account', 'Type', 'Annual budget', 'Budget to date', 'Actual to date', 'Variance', 'Variance %', 'Favourable / Adverse', 'Used of annual %'],
      ...rows.map((r) => [r.code, r.name, r.type, rupees(r.budgetPaise), rupees(r.budgetToDatePaise), rupees(r.actualPaise), rupees(r.varianceToDatePaise), r.variancePct.toFixed(1), r.favourable ? 'Favourable' : 'Adverse', r.pct.toFixed(1)]),
      ['', 'Total', '', rupees(totalBudget), rupees(totalToDate), '', rupees(totalVariance), '', totalVariance >= 0 ? 'Favourable' : 'Adverse', ''],
    ]);
  };

  // Only accounts that do not already have a figure for this year.
  const available = (chart.data?.accounts ?? []).filter(
    (a) => (a.type === 'expense' || a.type === 'income') && !(state.data?.rows ?? []).some((r) => r.accountId === a.id),
  );

  return (
    <>
      <PageHeader
        title="Budgets"
        description="A plan per account for the year, against what the ledger shows: the budget to date, the variance in rupees and per cent, favourable or adverse, month by month."
        actions={
          <>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={exportIt} disabled={!state.data?.rows.length} data-slot="budget-export">
              <Download className="size-4" /> Export
            </Button>
            {canEdit && dirty && (
              <Button size="sm" onClick={commit} disabled={save.busy} className="gap-1.5">
                <Save className="size-4" /> {save.busy ? 'Saving…' : 'Save changes'}
              </Button>
            )}
            {canEdit && (
              <Dialog open={adding} onOpenChange={setAdding}>
                <DialogTrigger asChild>
                  <Button size="sm" variant={dirty ? 'outline' : 'default'} className="gap-1.5">
                    <Plus className="size-4" /> Budget an account
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Add a budget line</DialogTitle>
                    <DialogDescription>
                      One figure per account for FY {fy}: a cost to keep under, or income to reach. Actuals are matched to it by account,
                      so nothing has to be categorised twice.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    <Field label="Account" required>
                      <Combobox
                        options={available.map((a) => ({ value: a.id, label: a.name, sublabel: `${a.code} · ${a.type}` }))}
                        value={newAccount}
                        onChange={setNewAccount}
                        placeholder="Select an income or expense account"
                        searchPlaceholder="Search accounts"
                        showAvatar={false}
                      />
                    </Field>
                    <Field label="Annual budget" required>
                      <MoneyInput valuePaise={newAmount} onChangePaise={setNewAmount} />
                    </Field>
                    {save.error && <p className="text-sm text-destructive">{save.error}</p>}
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setAdding(false)}>Cancel</Button>
                    <Button onClick={addAccount} disabled={save.busy}>
                      {save.busy ? 'Saving…' : 'Add budget'}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            )}
          </>
        }
      />

      <Card className="flex flex-wrap items-end gap-3 p-3" data-slot="budget-filters">
        <label className="space-y-1 text-[11px] font-medium text-muted-foreground">
          <span className="block">Financial year</span>
          <select value={fy} onChange={(e) => { setFy(e.target.value); setAsOf(''); }} className="h-9 w-32 rounded-md border bg-background px-2 text-sm" aria-label="Financial year">
            {yearChoices(todayIso).map((y) => <option key={y} value={y}>FY {y}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-[11px] font-medium text-muted-foreground">
          <span className="block">Actuals up to</span>
          <Input type="date" value={asOf || state.data?.asOf || ''} onChange={(e) => setAsOf(e.target.value)} className="h-9 w-40" aria-label="Actuals up to" />
        </label>
        <div className="w-44"><BranchSelect value={branch} onChange={setBranch} /></div>
        {(centres.data?.centres ?? []).length > 0 && (
          <label className="space-y-1 text-[11px] font-medium text-muted-foreground">
            <span className="block">Cost centre</span>
            <select value={centre} onChange={(e) => setCentre(e.target.value)} className="h-9 w-48 rounded-md border bg-background px-2 text-sm" aria-label="Cost centre" data-slot="budget-centre">
              <option value="">All cost centres</option>
              {centres.data!.centres.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
            </select>
          </label>
        )}
        <div className="ml-auto flex rounded-[3px] border p-0.5 text-xs" role="group" aria-label="View">
          {([['ytd', 'Year to date'], ['monthly', 'Month by month']] as const).map(([v, l]) => (
            <button key={v} type="button" onClick={() => setView(v)} aria-pressed={view === v} data-slot={`budget-view-${v}`}
              className={view === v ? 'rounded-[2px] bg-primary px-2.5 py-1 text-primary-foreground' : 'px-2.5 py-1 text-muted-foreground hover:text-foreground'}>
              {l}
            </button>
          ))}
        </div>
      </Card>

      <AsyncPage state={state}>
        {(d) =>
          d.rows.length === 0 ? (
            <EmptyState
              icon={BarChart3}
              title={`No budgets set for FY ${d.fy}`}
              description="Add a figure for the accounts you want to watch: rent, salaries, purchases, or a sales target."
            />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-4">
                <Card className="p-4">
                  <p className="text-xs text-muted-foreground">Annual budget</p>
                  <Money value={totalBudget} className="mt-1 block text-2xl font-semibold" />
                  <p className="mt-0.5 text-xs text-muted-foreground">FY {d.fy}{branchName ? ` · ${branchName}` : ''}</p>
                </Card>
                <Card className="p-4">
                  <p className="text-xs text-muted-foreground">Budget to date</p>
                  <Money value={totalToDate} className="mt-1 block text-2xl font-semibold" />
                  <p className="mt-0.5 text-xs text-muted-foreground">{elapsed.toFixed(0)}% of the year, to {new Date(d.asOf).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
                </Card>
                <Card className="p-4">
                  <p className="text-xs text-muted-foreground">Spent to date</p>
                  <Money value={spend.reduce((t, r) => t + r.actualPaise, 0)} className="mt-1 block text-2xl font-semibold" />
                  {earn.length > 0 && <p className="mt-0.5 text-xs text-muted-foreground">Earned <Money value={earn.reduce((t, r) => t + r.actualPaise, 0)} /></p>}
                </Card>
                <Card className={'p-4 ' + (totalVariance >= 0 ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-destructive/40 bg-destructive/5')} data-slot="budget-variance-total">
                  <p className="text-xs text-muted-foreground">Variance to date</p>
                  <Money value={totalVariance} className="mt-1 block text-2xl font-semibold" />
                  <p className="mt-0.5 text-xs font-medium">{totalVariance >= 0 ? 'Favourable' : 'Adverse'}</p>
                </Card>
              </div>

              {view === 'ytd' ? (
                <Card className="overflow-hidden p-0">
                  <div className="overflow-x-auto thin-scroll">
                    <table className="w-full text-sm" data-slot="budget-table">
                      <thead>
                        <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                          <th className="px-4 py-2.5 text-left font-semibold">Account</th>
                          <th className="w-40 px-4 py-2.5 text-right font-semibold">Annual budget</th>
                          <th className="px-4 py-2.5 text-right font-semibold">Budget to date</th>
                          <th className="px-4 py-2.5 text-right font-semibold">Actual to date</th>
                          <th className="px-4 py-2.5 text-right font-semibold">Variance</th>
                          <th className="px-4 py-2.5 text-right font-semibold">Variance %</th>
                          <th className="w-40 px-4 py-2.5 text-left font-semibold">Used of annual</th>
                          {(canEdit || canDelete) && <th className="w-[150px] px-2 py-2.5 text-right font-semibold">Actions</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.accountId} className="border-b last:border-0">
                            <td className="px-4 py-2.5">
                              <span className="font-mono text-xs text-muted-foreground">{r.code}</span>{' '}
                              <span className="font-medium">{r.name}</span>
                              {r.type === 'income' && <Badge variant="outline" className="ml-2 text-[9px]">Income</Badge>}
                            </td>
                            <td className="px-4 py-2">
                              {canEdit ? (
                                <MoneyInput valuePaise={r.budgetPaise} onChangePaise={(p) => setDraft((b) => ({ ...b, [r.accountId]: p }))} className="h-8" />
                              ) : (
                                <Money value={r.budgetPaise} className="block text-right" />
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-right"><Money value={r.budgetToDatePaise} /></td>
                            <td className="px-4 py-2.5 text-right"><Money value={r.actualPaise} /></td>
                            <td className="px-4 py-2.5 text-right">
                              <Money value={r.varianceToDatePaise} colored className="font-medium" />
                              <Badge variant="outline" className={`ml-2 text-[9px] ${r.favourable ? 'border-emerald-500/40 text-emerald-700' : 'border-red-500/40 text-red-700'}`} data-slot="budget-fa">
                                {r.favourable ? 'F' : 'A'}
                              </Badge>
                            </td>
                            <td className={`px-4 py-2.5 text-right tabular-nums ${r.favourable ? 'text-emerald-700' : 'text-red-700'}`}>{r.variancePct >= 0 ? '+' : ''}{r.variancePct.toFixed(1)}%</td>
                            <td className="px-4 py-2.5">
                              <Progress value={Math.min(100, r.pct)} className={r.pct > 100 && r.type !== 'income' ? '[&>div]:bg-red-500' : '[&>div]:bg-emerald-500'} />
                              <p className="mt-1 text-[10px] text-muted-foreground">{r.pct.toFixed(0)}% of the year&apos;s figure</p>
                            </td>
                            {(canEdit || canDelete) && (
                              <td className="whitespace-nowrap px-2 py-2">
                                <RowActions
                                  label={`the budget on ${r.code} ${r.name}`}
                                  canEdit={canEdit}
                                  canDelete={canDelete}
                                  onEdit={() => { setEditing(r); setEditAmount(r.budgetPaise); setEditNotes(r.notes ?? ''); }}
                                  onDelete={async (reason) => { await api.delete(withReason(`/api/budgets?fy=${encodeURIComponent(fy)}&accountId=${r.accountId}`, reason)); state.refetch(); }}
                                  done={`Budget line ${r.code} ${r.name} deleted`}
                                  deleteTitle={`Delete the FY ${fy} budget on ${r.code} ${r.name}?`}
                                  deleteDescription="Only the plan goes: the actuals stay in the ledger, and the account can be budgeted again."
                                />
                              </td>
                            )}
                          </tr>
                        ))}
                        <tr className="border-t-2 bg-muted/40 font-semibold">
                          <td className="px-4 py-2.5">Total</td>
                          <td className="px-4 py-2.5 text-right"><Money value={totalBudget} /></td>
                          <td className="px-4 py-2.5 text-right"><Money value={totalToDate} /></td>
                          <td className="px-4 py-2.5" />
                          <td className="px-4 py-2.5 text-right"><Money value={totalVariance} colored /></td>
                          <td className="px-4 py-2.5 text-right">{totalToDate > 0 ? `${((totalVariance / totalToDate) * 100).toFixed(1)}%` : ''}</td>
                          <td className="px-4 py-2.5" />
                          {(canEdit || canDelete) && <td />}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </Card>
              ) : (
                <Card className="overflow-hidden p-0">
                  <div className="overflow-x-auto thin-scroll">
                    <table className="w-full text-xs" data-slot="budget-monthly">
                      <thead>
                        <tr className="border-b bg-muted/50 text-[10px] uppercase tracking-wide text-muted-foreground">
                          <th rowSpan={2} className="sticky left-0 bg-muted/50 px-3 py-2 text-left font-semibold">Account</th>
                          {d.months.map((m) => <th key={m} colSpan={3} className="border-l px-2 py-1.5 text-center font-semibold">{monthLabel(m)}</th>)}
                        </tr>
                        <tr className="border-b bg-muted/30 text-[10px] text-muted-foreground">
                          {d.months.map((m) => (
                            <Fragment key={m}>
                              <th className="border-l px-2 py-1 text-right font-medium">Budget</th>
                              <th className="px-2 py-1 text-right font-medium">Actual</th>
                              <th className="px-2 py-1 text-right font-medium">Variance</th>
                            </Fragment>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.accountId} className="border-b last:border-0">
                            <td className="sticky left-0 whitespace-nowrap bg-background px-3 py-2"><span className="font-mono text-muted-foreground">{r.code}</span> {r.name}</td>
                            {r.months.map((m) => (
                              <Fragment key={m.month}>
                                <td className="border-l px-2 py-2 text-right tabular-nums">{(m.budgetPaise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                                <td className="px-2 py-2 text-right tabular-nums">{(m.actualPaise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                                <td className={`px-2 py-2 text-right tabular-nums ${m.variancePaise >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>{(m.variancePaise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                              </Fragment>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </>
          )
        }
      </AsyncPage>

      <Dialog open={!!editing} onOpenChange={(v) => { if (!v) setEditing(null); }}>
        <DialogContent data-slot="budget-edit">
          <DialogHeader>
            <DialogTitle>Edit budget: {editing?.code} {editing?.name}</DialogTitle>
            <DialogDescription>The figure for FY {fy}. Actuals are read from the ledger and do not change.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Field label="Annual budget" required><MoneyInput valuePaise={editAmount} onChangePaise={setEditAmount} /></Field>
            <Field label="Note"><Input value={editNotes} onChange={(e) => setEditNotes(e.target.value)} placeholder="How the figure was arrived at" maxLength={500} /></Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={() => void saveLine()} disabled={editBusy} data-slot="budget-edit-save">{editBusy ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card className="flex items-start gap-3 p-4">
        <BarChart3 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          Actuals are never typed in: they are read from the same journal entries that produce your Profit &amp; Loss, narrowed to the branch
          or cost centre chosen. The year&apos;s budget is spread evenly over its days, so the budget to date and each month&apos;s share
          follow the calendar. A variance is favourable when spending is under the budget or income is over it. Setting a budget to zero
          removes the line.
        </p>
      </Card>
    </>
  );
}
