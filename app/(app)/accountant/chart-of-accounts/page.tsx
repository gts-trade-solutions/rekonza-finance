'use client';

// The chart of accounts — the list of buckets every rupee gets sorted into.
//
// Balances are shown in each family's natural direction, so a liability with a
// large credit balance reads as a positive number rather than a negative one.
// It is the same figure either way; the sign convention is just a source of
// confusion for anyone who does not think in debits.

import { useMemo, useState } from 'react';
import { Lock, Plus, ScrollText, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { AsyncPage } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import { accounts as accountsApi, type AccountRow } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

type AccountType = AccountRow['type'];

const TYPE_INFO: Record<AccountType, { label: string; plain: string; tone: string }> = {
  asset: { label: 'Assets', plain: 'What the business owns', tone: 'text-blue-600 dark:text-blue-400' },
  liability: { label: 'Liabilities', plain: 'What the business owes', tone: 'text-amber-600 dark:text-amber-400' },
  equity: { label: 'Equity', plain: "The owners' stake", tone: 'text-purple-600 dark:text-purple-400' },
  income: { label: 'Income', plain: 'What the business earns', tone: 'text-emerald-600 dark:text-emerald-400' },
  expense: { label: 'Expenses', plain: 'What the business spends', tone: 'text-red-600 dark:text-red-400' },
};

const ORDER: AccountType[] = ['asset', 'liability', 'equity', 'income', 'expense'];

export default function ChartOfAccountsPage() {
  const canCreate = usePermission('accountant', 'create');
  const canEdit = usePermission('accountant', 'edit');
  const state = useApi<{ accounts: AccountRow[] }>(() => accountsApi.list(), []);

  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ code: '', name: '', type: 'expense' as AccountType, description: '' });

  const create = useApiAction(accountsApi.create);
  const remove = useApiAction(accountsApi.remove);

  const byType = useMemo(() => {
    const m = new Map<AccountType, AccountRow[]>();
    for (const t of ORDER) m.set(t, []);
    for (const a of state.data?.accounts ?? []) m.get(a.type)?.push(a);
    return m;
  }, [state.data]);

  const save = async () => {
    if (!f.code.trim() || !f.name.trim()) {
      toast.error('Code and name are required.');
      return;
    }
    const result = await create.run({
      code: f.code.trim(),
      name: f.name.trim(),
      type: f.type,
      description: f.description.trim() || null,
    });
    if (!result) {
      toast.error(create.error ?? 'The account was not created');
      return;
    }
    toast.success(`${result.code} — ${result.name} created`);
    setOpen(false);
    setF({ code: '', name: '', type: 'expense', description: '' });
    state.refetch();
  };

  const drop = async (a: AccountRow) => {
    const done = await remove.run(a.id);
    if (!done) {
      toast.error(remove.error ?? `${a.code} could not be deleted`);
      return;
    }
    toast.info(`${a.code} removed`);
    state.refetch();
  };

  return (
    <>
      <PageHeader
        title="Chart of accounts"
        description="The list of buckets every rupee gets sorted into. Everything in the app ultimately lands in one of these."
        actions={
          canCreate && (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="gap-1.5"><Plus className="size-4" /> New account</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>New account</DialogTitle></DialogHeader>
                <div className="space-y-4">
                  <Field label="Account type" required hint={TYPE_INFO[f.type].plain}>
                    <Select value={f.type} onValueChange={(v) => setF({ ...f, type: v as AccountType })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {ORDER.map((t) => (
                          <SelectItem key={t} value={t}>{TYPE_INFO[t].label} — {TYPE_INFO[t].plain}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <div className="grid grid-cols-3 gap-4">
                    <Field label="Code" required error={create.fieldErrors.code}>
                      <Input
                        value={f.code}
                        onChange={(e) => setF({ ...f, code: e.target.value })}
                        placeholder="6750"
                        className="font-mono"
                      />
                    </Field>
                    <Field label="Account name" required className="col-span-2" error={create.fieldErrors.name}>
                      <Input
                        value={f.name}
                        onChange={(e) => setF({ ...f, name: e.target.value })}
                        placeholder="Account name"
                      />
                    </Field>
                  </div>
                  <Field label="Description" hint="What belongs in this account, for whoever posts next">
                    <Input
                      value={f.description}
                      onChange={(e) => setF({ ...f, description: e.target.value })}
                      placeholder="What this account is for"
                    />
                  </Field>
                  {create.error && <p className="text-sm text-destructive">{create.error}</p>}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button onClick={save} disabled={create.busy}>
                    {create.busy ? 'Saving…' : 'Create account'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )
        }
      />

      <AsyncPage state={state}>
        {() => (
          <div className="space-y-6">
            {ORDER.map((type) => {
              const list = byType.get(type) ?? [];
              const groupTotal = list.reduce((t, a) => t + a.balancePaise, 0);
              return (
                <section key={type}>
                  <div className="mb-2 flex items-baseline justify-between">
                    <div>
                      <h2 className={`text-sm font-semibold ${TYPE_INFO[type].tone}`}>{TYPE_INFO[type].label}</h2>
                      <p className="text-xs text-muted-foreground">{TYPE_INFO[type].plain}</p>
                    </div>
                    <Money value={groupTotal} className="text-sm font-semibold" />
                  </div>
                  <Card className="overflow-hidden p-0">
                    <table className="w-full text-sm">
                      <tbody>
                        {list.map((a) => (
                          <tr key={a.id} className="group border-b last:border-0 hover:bg-accent/40">
                            <td className="w-20 px-4 py-2 font-mono text-xs text-muted-foreground">{a.code}</td>
                            <td className="px-4 py-2">
                              <div className="flex items-center gap-2">
                                <span className="font-medium">{a.name}</span>
                                {a.isSystem && (
                                  <Badge variant="secondary" className="gap-1 text-[9px]">
                                    <Lock className="size-2.5" /> System
                                  </Badge>
                                )}
                              </div>
                              {a.description && <p className="text-xs text-muted-foreground">{a.description}</p>}
                            </td>
                            <td className="w-24 px-4 py-2 text-right text-xs text-muted-foreground tabular">
                              {a.lineCount > 0 ? `${a.lineCount} postings` : 'unused'}
                            </td>
                            <td className="w-40 px-4 py-2 text-right">
                              <Money
                                value={a.balancePaise}
                                showZero={false}
                                className={a.balancePaise !== 0 ? 'font-medium' : undefined}
                              />
                            </td>
                            <td className="w-10 px-2 py-2">
                              {canEdit && !a.isSystem && a.lineCount === 0 && (
                                <button
                                  type="button"
                                  aria-label={`Delete ${a.code}`}
                                  disabled={remove.busy}
                                  onClick={() => void drop(a)}
                                  className="grid size-7 place-items-center rounded text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 disabled:opacity-40"
                                >
                                  <Trash2 className="size-3.5" />
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>
                </section>
              );
            })}
          </div>
        )}
      </AsyncPage>

      <Card className="flex items-start gap-3 p-4">
        <ScrollText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          Accounts marked <span className="font-medium">System</span> are wired into how the app posts — Accounts
          Receivable, the GST ledgers, TDS, and so on. They can be renamed but never deleted or retyped, because
          the posting engine finds them by code and the entries that already reference them would break. Any
          account with postings against it can be switched off but not deleted, for the same reason.
        </p>
      </Card>
    </>
  );
}
