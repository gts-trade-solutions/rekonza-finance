'use client';

// Budgets vs actual.
//
// Actual spend is never typed in — it is read from the same journal entries
// that produce the Profit & Loss, matched to the budget by account id. There is
// no category mapping in the middle, so the two sides cannot drift apart.
//
// The comparison runs year-to-date rather than against the whole year. A
// full-year budget against four months of actuals makes everything look
// comfortably under; the "pace" column is what actually tells you.

import { useEffect, useMemo, useState } from 'react';
import { BarChart3, Plus, Save } from 'lucide-react';
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
import {
  accounts as accountsApi, budgets as budgetsApi,
  type AccountRow, type BudgetResponse,
} from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

/** '2026-27' for any date in the 2026-27 financial year. India runs Apr–Mar. */
function fyLabelFor(date: string): string {
  const [y, m] = date.split('-').map(Number);
  const start = m < 4 ? y - 1 : y;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export default function BudgetsPage() {
  const canEdit = usePermission('accountant', 'edit');
  const fy = fyLabelFor(new Date().toISOString().slice(0, 10));

  const state = useApi<BudgetResponse>(() => budgetsApi.list({ fy }), [fy]);
  const chart = useApi<{ accounts: AccountRow[] }>(() => accountsApi.list({ type: 'expense' }), []);

  // Edits are held locally until saved, so typing a figure does not fire a
  // request on every keystroke.
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [adding, setAdding] = useState(false);
  const [newAccount, setNewAccount] = useState('');
  const [newAmount, setNewAmount] = useState(0);

  const save = useApiAction(budgetsApi.set);

  useEffect(() => {
    setDraft({});
  }, [state.data]);

  const dirty = Object.keys(draft).length > 0;

  const rows = useMemo(() => {
    const base = state.data?.rows ?? [];
    return base.map((r) => {
      const budget = draft[r.accountId] ?? r.budgetPaise;
      return {
        ...r,
        budgetPaise: budget,
        variancePaise: budget - r.actualPaise,
        pct: budget > 0 ? (r.actualPaise / budget) * 100 : 0,
      };
    }).sort((a, b) => b.pct - a.pct);
  }, [state.data, draft]);

  const totalBudget = rows.reduce((t, r) => t + r.budgetPaise, 0);
  const totalActual = rows.reduce((t, r) => t + r.actualPaise, 0);
  const elapsed = state.data?.elapsedPct ?? 0;

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

  // Only accounts that do not already have a figure for this year.
  const available = (chart.data?.accounts ?? []).filter(
    (a) => !(state.data?.rows ?? []).some((r) => r.accountId === a.id),
  );

  return (
    <>
      <PageHeader
        title="Budgets vs actual"
        description="Set a spending plan per account for the year, then watch how reality tracks against it. Actuals come straight from the ledger."
        actions={
          canEdit && (
            <>
              {dirty && (
                <Button size="sm" onClick={commit} disabled={save.busy} className="gap-1.5">
                  <Save className="size-4" /> {save.busy ? 'Saving…' : 'Save changes'}
                </Button>
              )}
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
                      One figure per account for FY {fy}. Actuals are matched to it by account, so nothing has to
                      be categorised twice.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    <Field label="Account" required>
                      <Combobox
                        options={available.map((a) => ({
                          value: a.id,
                          label: a.name,
                          sublabel: a.code,
                        }))}
                        value={newAccount}
                        onChange={setNewAccount}
                        placeholder="Select an expense account"
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
            </>
          )
        }
      />

      <AsyncPage state={state}>
        {(d) =>
          d.rows.length === 0 ? (
            <EmptyState
              icon={BarChart3}
              title={`No budgets set for FY ${d.fy}`}
              description="Add a figure for the accounts you actually want to watch — rent, salaries, purchases."
            />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Card className="p-4">
                  <p className="text-xs text-muted-foreground">Annual budget</p>
                  <Money value={totalBudget} className="mt-1 block text-2xl font-semibold" />
                  <p className="mt-0.5 text-xs text-muted-foreground">FY {d.fy}</p>
                </Card>
                <Card className="p-4">
                  <p className="text-xs text-muted-foreground">Spent so far</p>
                  <Money value={totalActual} className="mt-1 block text-2xl font-semibold" />
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {totalBudget > 0
                      ? `${((totalActual / totalBudget) * 100).toFixed(0)}% of budget · ${elapsed.toFixed(0)}% of the year gone`
                      : '—'}
                  </p>
                </Card>
                <Card
                  className={
                    'p-4 ' +
                    (totalBudget - totalActual >= 0
                      ? 'border-emerald-500/40 bg-emerald-500/5'
                      : 'border-destructive/40 bg-destructive/5')
                  }
                >
                  <p className="text-xs text-muted-foreground">Remaining</p>
                  <Money value={totalBudget - totalActual} className="mt-1 block text-2xl font-semibold" />
                </Card>
              </div>

              <Card className="overflow-hidden p-0">
                <div className="overflow-x-auto thin-scroll">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-4 py-2.5 text-left font-semibold">Account</th>
                        <th className="w-40 px-4 py-2.5 text-right font-semibold">Budget</th>
                        <th className="px-4 py-2.5 text-right font-semibold">Actual</th>
                        <th className="w-48 px-4 py-2.5 text-left font-semibold">Progress</th>
                        <th className="px-4 py-2.5 text-right font-semibold">Variance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => {
                        // Ahead of pace, not merely over the annual figure.
                        const overPace = r.pct > elapsed + 10;
                        return (
                          <tr key={r.accountId} className="border-b last:border-0">
                            <td className="px-4 py-2.5">
                              <span className="font-mono text-xs text-muted-foreground">{r.code}</span>{' '}
                              <span className="font-medium">{r.name}</span>
                            </td>
                            <td className="px-4 py-2">
                              {canEdit ? (
                                <MoneyInput
                                  valuePaise={r.budgetPaise}
                                  onChangePaise={(p) => setDraft((b) => ({ ...b, [r.accountId]: p }))}
                                  className="h-8"
                                />
                              ) : (
                                <Money value={r.budgetPaise} className="block text-right" />
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-right"><Money value={r.actualPaise} /></td>
                            <td className="px-4 py-2.5">
                              <Progress
                                value={Math.min(100, r.pct)}
                                className={
                                  r.pct > 100
                                    ? '[&>div]:bg-red-500'
                                    : overPace
                                      ? '[&>div]:bg-amber-500'
                                      : '[&>div]:bg-emerald-500'
                                }
                              />
                              <p className="mt-1 text-[10px] text-muted-foreground">
                                {r.pct.toFixed(0)}% used
                                {overPace && r.pct <= 100 ? ' · ahead of pace' : ''}
                              </p>
                            </td>
                            <td className="px-4 py-2.5 text-right">
                              <Money value={r.variancePaise} colored className="font-medium" />
                              {r.variancePaise < 0 && (
                                <Badge variant="outline" className="ml-2 border-red-500/40 text-[9px]">Over</Badge>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          )
        }
      </AsyncPage>

      <Card className="flex items-start gap-3 p-4">
        <BarChart3 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          Actual spend is never typed in — it is read from the same journal entries that produce your Profit &amp;
          Loss, so the two can never disagree. Setting a budget to zero removes the line entirely rather than
          storing a target of nothing.
        </p>
      </Card>
    </>
  );
}
