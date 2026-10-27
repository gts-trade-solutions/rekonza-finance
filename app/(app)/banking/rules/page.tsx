'use client';

// Bank rules — teach the app to categorise repeating statement lines.
//
// Rules run in priority order and the first match wins, so a specific rule has
// to sit above a general one. Auto-confirm is off by default on purpose: a rule
// that silently miscategorises is worse than one that asks, because a wrong
// account only surfaces at year end when somebody queries the figure.

import { useState } from 'react';
import { Plus, ScrollText, Trash2, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { Field } from '@/components/shared/form-bits';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { accounts as accountsApi, api, type AccountRow } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

interface RuleRow {
  id: string;
  name: string;
  priority: number;
  conditions: { field: string; op: string; value: string }[];
  accountId: string | null;
  accountCode: string | null;
  accountName: string | null;
  bankAccountId: string | null;
  bankName: string | null;
  autoConfirm: boolean;
  isActive: boolean;
  timesApplied: number;
}

/** Control accounts get their balance from documents, never from a bank line. */
const CONTROL_CODES = new Set(['1100', '2100']);

export default function BankRulesPage() {
  const canEdit = usePermission('banking', 'edit');
  const state = useApi<{ rules: RuleRow[] }>(() => api.get('/api/banking/rules'), []);
  const chart = useApi<{ accounts: AccountRow[] }>(() => accountsApi.list(), []);

  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', contains: '', accountId: '', autoConfirm: false });

  const create = useApiAction((input: unknown) => api.post<{ id: string }>('/api/banking/rules', input));
  const patch = useApiAction((input: unknown) =>
    api.patch<{ matched?: number; isActive?: boolean }>('/api/banking/rules', input),
  );
  const remove = useApiAction((id: string) =>
    api.delete<{ id: string }>(`/api/banking/rules?id=${encodeURIComponent(id)}`),
  );
  const busy = patch.busy || remove.busy;

  const accountChoices = (chart.data?.accounts ?? [])
    .filter((a) => (a.type === 'expense' || a.type === 'income') && !CONTROL_CODES.has(a.code))
    .map((a) => ({ value: a.id, label: a.name, sublabel: `${a.code} · ${a.type}` }));

  const save = async () => {
    if (!f.name.trim() || !f.contains.trim() || !f.accountId) {
      toast.error('Fill in the rule name, the text to match, and a category.');
      return;
    }
    const done = await create.run({
      name: f.name.trim(),
      contains: f.contains.trim(),
      accountId: f.accountId,
      autoConfirm: f.autoConfirm,
    });
    if (!done) {
      toast.error(create.error ?? 'The rule was not created');
      return;
    }
    toast.success('Rule created', {
      description: f.autoConfirm
        ? 'Matching lines will be categorised without review.'
        : 'Matching lines will be suggested for review.',
    });
    setOpen(false);
    setF({ name: '', contains: '', accountId: '', autoConfirm: false });
    state.refetch();
  };

  const runAll = async () => {
    const done = await patch.run({ action: 'run' });
    if (!done) {
      toast.error(patch.error ?? 'The rules did not run');
      return;
    }
    toast.success(`${done.matched ?? 0} line(s) matched`);
    state.refetch();
  };

  const toggle = async (r: RuleRow, v: boolean) => {
    const done = await patch.run({ action: 'toggle', id: r.id, isActive: v });
    if (!done) {
      toast.error(patch.error ?? 'That could not be changed');
      return;
    }
    state.refetch();
  };

  const drop = async (r: RuleRow) => {
    const done = await remove.run(r.id);
    if (!done) {
      toast.error(remove.error ?? 'The rule was not deleted');
      return;
    }
    toast.info(`${r.name} deleted`, { description: 'Lines it already categorised are unaffected.' });
    state.refetch();
  };

  return (
    <>
      <PageHeader
        title="Bank rules"
        description="Teach the app to categorise repeating transactions so you never code the same fuel bill twice."
        actions={
          canEdit && (
            <>
              <Button variant="outline" size="sm" className="gap-1.5" disabled={busy} onClick={() => void runAll()}>
                <Zap className="size-3.5" /> {patch.busy ? 'Running…' : 'Run all rules'}
              </Button>
              <Dialog open={open} onOpenChange={setOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" className="gap-1.5"><Plus className="size-4" /> New rule</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>New bank rule</DialogTitle>
                    <DialogDescription>
                      Rules run in order and the first match wins, so put specific ones above general ones.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    <Field label="Rule name" required error={create.fieldErrors.name}>
                      <Input
                        value={f.name}
                        onChange={(e) => setF({ ...f, name: e.target.value })}
                        placeholder="Rule name"
                      />
                    </Field>
                    <Field
                      label="When the narration contains"
                      required
                      error={create.fieldErrors.contains}
                      hint="Match the part that never changes, not the part with a reference number in it"
                    >
                      <Input
                        value={f.contains}
                        onChange={(e) => setF({ ...f, contains: e.target.value })}
                        placeholder="Text as it appears on the statement"
                      />
                    </Field>
                    <Field label="Categorise as" required>
                      <Combobox
                        options={accountChoices}
                        value={f.accountId}
                        onChange={(v) => setF({ ...f, accountId: v })}
                        placeholder="Select account"
                        searchPlaceholder="Search accounts by name or code"
                        showAvatar={false}
                      />
                    </Field>
                    <div className="flex items-center justify-between gap-3 rounded-md border p-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">Auto-confirm matches</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Off means the match is suggested and you approve it. Leave it off until you have watched
                          the rule behave for a month.
                        </p>
                      </div>
                      <Switch checked={f.autoConfirm} onCheckedChange={(v) => setF({ ...f, autoConfirm: v })} />
                    </div>
                    {create.error && <p className="text-sm text-destructive">{create.error}</p>}
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                    <Button onClick={save} disabled={create.busy}>
                      {create.busy ? 'Saving…' : 'Create rule'}
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
          d.rules.length === 0 ? (
            <EmptyState
              icon={ScrollText}
              title="No rules yet"
              description="Create a rule to auto-categorise recurring bank lines."
            />
          ) : (
            <div className="space-y-3">
              {d.rules.map((r) => (
                <Card key={r.id} className="flex flex-wrap items-center gap-4 p-4">
                  <Badge variant="secondary" className="shrink-0 tabular">#{r.priority}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{r.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      When narration contains{' '}
                      {r.conditions.map((c) => (
                        <span key={c.value} className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
                          {c.value}
                        </span>
                      ))}{' '}
                      → categorise as{' '}
                      <span className="font-medium text-foreground">{r.accountName ?? 'unset'}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {r.timesApplied > 0
                        ? `Applied to ${r.timesApplied} line(s)`
                        : 'Has not matched anything yet'}
                    </p>
                  </div>
                  {r.autoConfirm && <Badge variant="outline" className="text-[10px]">Auto-confirm</Badge>}
                  {canEdit && (
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={r.isActive}
                        disabled={busy}
                        onCheckedChange={(v) => void toggle(r, v)}
                      />
                      <button
                        type="button"
                        aria-label={`Delete ${r.name}`}
                        disabled={busy}
                        onClick={() => void drop(r)}
                        className="grid size-8 place-items-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )
        }
      </AsyncPage>

      <Card className="flex items-start gap-3 p-4">
        <ScrollText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          A rule cannot point at Accounts Receivable or Accounts Payable. Those balances come from invoices and
          bills, so a statement line categorised straight into one would leave the ageing report disagreeing with
          its own control account — match the line to the document instead.
        </p>
      </Card>
    </>
  );
}
