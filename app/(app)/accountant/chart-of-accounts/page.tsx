'use client';

// The chart of accounts — the list of buckets every rupee gets sorted into.
//
// Balances are shown in each family's natural direction, so a liability with a
// large credit balance reads as a positive number rather than a negative one.
// It is the same figure either way; the sign convention is just a source of
// confusion for anyone who does not think in debits.

import { useMemo, useState } from 'react';
import { Lock, Plus, ScrollText } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { PageHeader } from '@/components/shared/page-header';
import { ModuleMenu } from '@/components/shared/module-menu';
import { Money } from '@/components/shared/money';
import { AsyncPage } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import { RowActions } from '@/components/shared/row-actions';
import { Switch } from '@/components/ui/switch';
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

/**
 * Accounts as a tree: each group (an account others sit under, like Tally's
 * groups) followed by its members, indented, with the group's total covering
 * everything beneath it.
 */
function tree(list: AccountRow[]) {
  const ids = new Set(list.map((a) => a.id));
  const kids = new Map<string, AccountRow[]>();
  for (const a of list) {
    const parent = a.parentId && ids.has(a.parentId) ? a.parentId : '';
    kids.set(parent, [...(kids.get(parent) ?? []), a]);
  }
  const total = (a: AccountRow): number => a.balancePaise + (kids.get(a.id) ?? []).reduce((t, c) => t + total(c), 0);
  const out: { a: AccountRow; depth: number; isGroup: boolean; groupTotal: number }[] = [];
  const walk = (parent: string, depth: number) => {
    for (const a of [...(kids.get(parent) ?? [])].sort((x, y) => x.code.localeCompare(y.code))) {
      const isGroup = (kids.get(a.id) ?? []).length > 0;
      out.push({ a, depth, isGroup, groupTotal: total(a) });
      if (depth < 6) walk(a.id, depth + 1);
    }
  };
  walk('', 0);
  return out;
}

export default function ChartOfAccountsPage() {
  const canCreate = usePermission('accountant', 'create');
  const canEdit = usePermission('accountant', 'edit');
  const canDelete = usePermission('accountant', 'void');
  // Inactive accounts are kept out of the pickers; shown here on asking, to be marked active again.
  const [showInactive, setShowInactive] = useState(false);
  const state = useApi<{ accounts: AccountRow[] }>(() => accountsApi.list({ inactive: showInactive }), [showInactive]);

  const [open, setOpen] = useState(false);
  // The account being edited, or null for a new one.
  const [editing, setEditing] = useState<AccountRow | null>(null);
  const blank = { code: '', name: '', type: 'expense' as AccountType, description: '', parentId: '' };
  const [f, setF] = useState(blank);

  const create = useApiAction(accountsApi.create);
  const update = useApiAction(accountsApi.update);

  const byType = useMemo(() => {
    const m = new Map<AccountType, AccountRow[]>();
    for (const t of ORDER) m.set(t, []);
    for (const a of state.data?.accounts ?? []) m.get(a.type)?.push(a);
    return m;
  }, [state.data]);

  const startNew = () => { setEditing(null); setF(blank); setOpen(true); };
  const startEdit = (a: AccountRow) => {
    setEditing(a);
    setF({ code: a.code, name: a.name, type: a.type, description: a.description ?? '', parentId: a.parentId ?? '' });
    setOpen(true);
  };

  const save = async () => {
    if (!f.code.trim() || !f.name.trim()) {
      toast.error('Code and name are required.');
      return;
    }
    const payload = {
      code: f.code.trim(),
      name: f.name.trim(),
      type: f.type,
      description: f.description.trim() || null,
      parentId: f.parentId || null,
    };
    if (editing) {
      const done = await update.run({ id: editing.id, ...payload });
      if (!done) {
        toast.error('Not saved', { description: update.error ?? `${editing.code} was not changed` });
        return;
      }
      toast.success(`${payload.code} — ${payload.name} saved`);
    } else {
      const result = await create.run(payload);
      if (!result) {
        toast.error(create.error ?? 'The account was not created');
        return;
      }
      toast.success(`${result.code} — ${result.name} created`);
    }
    setOpen(false);
    setEditing(null);
    setF(blank);
    state.refetch();
  };

  const setActive = async (a: AccountRow, active: boolean) => {
    await accountsApi.update({ id: a.id, isActive: active });
    state.refetch();
  };
  const busy = create.busy || update.busy;
  const action = editing ? update : create;
  const usedEditing = !!editing && (editing.isSystem || editing.lineCount > 0);

  return (
    <>
      <PageHeader
        title="Chart of Accounts"
        description="The list of buckets every rupee gets sorted into. Everything in the app ultimately lands in one of these."
        actions={<>
          <label className="flex items-center gap-2 text-xs text-muted-foreground" data-slot="accounts-show-inactive">
            <Switch checked={showInactive} onCheckedChange={setShowInactive} aria-label="Show inactive accounts" /> Show inactive
          </label>
          {canCreate && <Button size="sm" className="gap-1.5" onClick={startNew}><Plus className="size-4" /> New account</Button>}
          <ModuleMenu slug="accounts" onRefresh={() => void state.refetch()} />
        </>}
      />

      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setEditing(null); }}>
        <DialogContent data-slot="account-dialog">
          <DialogHeader><DialogTitle>{editing ? `Edit ${editing.code} — ${editing.name}` : 'New account'}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <Field label="Account type" required hint={usedEditing ? (editing!.isSystem ? 'A system account keeps its type: the app posts to it by code.' : 'It has postings, so its type stays: changing it would move history between the balance sheet and the profit and loss.') : TYPE_INFO[f.type].plain}>
              <Select value={f.type} onValueChange={(v) => setF({ ...f, type: v as AccountType, parentId: '' })} disabled={usedEditing}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ORDER.map((t) => (
                    <SelectItem key={t} value={t}>{TYPE_INFO[t].label} — {TYPE_INFO[t].plain}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="grid grid-cols-3 gap-4">
              <Field label="Code" required error={action.fieldErrors.code} hint={editing?.isSystem ? 'Fixed: found by its code.' : undefined}>
                <Input
                  value={f.code}
                  onChange={(e) => setF({ ...f, code: e.target.value })}
                  placeholder="6750"
                  className="font-mono"
                  disabled={!!editing?.isSystem}
                />
              </Field>
              <Field label="Account name" required className="col-span-2" error={action.fieldErrors.name}>
                <Input
                  value={f.name}
                  onChange={(e) => setF({ ...f, name: e.target.value })}
                  placeholder="Account name"
                />
              </Field>
            </div>
            <Field label="Under (group)" hint="Optional: the account it is grouped under, as Sundry Debtors holds each customer in Tally. Reports total a group with everything beneath it.">
              <select value={f.parentId} onChange={(e) => setF({ ...f, parentId: e.target.value })} className="h-9 w-full rounded-md border bg-background px-2 text-sm" data-slot="account-parent">
                <option value="">None: a top-level account</option>
                {(byType.get(f.type) ?? []).filter((a) => a.id !== editing?.id).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
              </select>
            </Field>
            <Field label="Description" hint="What belongs in this account, for whoever posts next">
              <Input
                value={f.description}
                onChange={(e) => setF({ ...f, description: e.target.value })}
                placeholder="What this account is for"
              />
            </Field>
            {action.error && <p className="text-sm text-destructive">{action.error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setOpen(false); setEditing(null); }}>Cancel</Button>
            <Button onClick={save} disabled={busy} data-slot="account-save">
              {busy ? 'Saving…' : editing ? 'Save' : 'Create account'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
                    <div className="overflow-x-auto thin-scroll">
                      <table className="w-full text-sm">
                        <tbody>
                          {tree(list).map(({ a, depth, isGroup, groupTotal: gt }) => (
                            <tr key={a.id} className={`group border-b last:border-0 hover:bg-accent/40 ${isGroup ? 'bg-muted/30' : ''} ${a.isActive ? '' : 'opacity-60'}`} data-slot="account-row">
                              <td className="w-20 px-4 py-2 font-mono text-xs text-muted-foreground">{a.code}</td>
                              <td className="px-4 py-2" style={{ paddingLeft: `${16 + depth * 20}px` }}>
                                <div className="flex items-center gap-2">
                                  <span className={isGroup ? 'font-semibold' : 'font-medium'}>{a.name}</span>
                                  {isGroup && <Badge variant="outline" className="text-[9px]">Group</Badge>}
                                  {!a.isActive && <Badge variant="outline" className="text-[9px]">Inactive</Badge>}
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
                                  value={isGroup ? gt : a.balancePaise}
                                  showZero={false}
                                  className={isGroup ? 'font-semibold' : a.balancePaise !== 0 ? 'font-medium' : undefined}
                                />
                              </td>
                              <td className="w-[240px] whitespace-nowrap px-2 py-1.5">
                                <RowActions
                                  label={`${a.code} ${a.name}`}
                                  canEdit={canEdit}
                                  // A system account is wired into posting: renamed, never deleted.
                                  canDelete={canDelete && !a.isSystem}
                                  onEdit={() => startEdit(a)}
                                  onDelete={async () => { await accountsApi.remove(a.id); state.refetch(); }}
                                  done={`${a.code} ${a.name} deleted`}
                                  deleteTitle={`Delete account ${a.code} — ${a.name}?`}
                                  deleteDescription={a.lineCount > 0
                                    ? `It has ${a.lineCount} posting${a.lineCount === 1 ? '' : 's'}, so it cannot be deleted: those entries would point at nothing. Mark it as inactive instead; it leaves the pickers and every report stays as it is.`
                                    : 'Nothing has been posted to it, so it can go. If an item, bank account or document names it, it is kept and you can mark it as inactive instead.'}
                                  alternativeUpfront={a.lineCount > 0 && a.isActive}
                                  alternative={a.isActive ? {
                                    label: 'Mark as inactive',
                                    note: 'Inactive: hidden from the pickers on new entries; its history and every report stay as they are.',
                                    run: () => setActive(a, false),
                                    done: `${a.code} ${a.name} marked as inactive`,
                                  } : undefined}
                                  extra={canEdit && !a.isActive ? (
                                    <Button size="xs" variant="outline" data-slot="account-activate"
                                      onClick={() => void setActive(a, true).then(() => toast.success(`${a.code} marked as active`), (e: Error) => toast.error('Not changed', { description: e.message }))}>
                                      Mark as active
                                    </Button>
                                  ) : undefined}
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
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
          Receivable, the GST ledgers, TDS, and so on. They can be renamed (Edit) but never deleted or retyped, because
          the posting engine finds them by code and the entries that already reference them would break. Any
          account with postings against it can be marked as inactive but not deleted, for the same reason.
        </p>
      </Card>
    </>
  );
}
