'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Recurring journals — entries that repeat unchanged: depreciation, prepaid
// rent amortisation, accrued salaries. The point is that nobody has to remember
// them, and they post with identical wording every period so the ledger reads
// consistently.
//
// A profile is a template, not a posting. Nothing reaches the ledger until it
// is run, and running it goes through the same posting engine as a hand-typed
// entry — so a locked period refuses it. An automation that could quietly post
// into a closed month would be worse than no automation at all.
// ─────────────────────────────────────────────────────────────────────────────

import { FoldNav } from '@/components/layout/nav-state';
import { useState } from 'react';
import { CalendarClock, Play, Plus, Repeat } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Combobox } from '@/components/ui/combobox';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { RowActions, withReason } from '@/components/shared/row-actions';
import {
  accounts as accountsApi, api, recurringJournals,
  type AccountRow, type RecurringJournalRow,
} from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';

const FREQUENCY = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
];

const today = () => new Date().toISOString().slice(0, 10);
const short = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN') : '—');

const BLANK = {
  name: '', frequency: 'monthly', nextRun: today(),
  debitAccountId: '', creditAccountId: '', amount: 0, memo: '',
};

export default function RecurringJournalsPage() {
  const canCreate = usePermission('accountant', 'create');
  const canEdit = usePermission('accountant', 'edit');
  const canDelete = usePermission('accountant', 'void');
  const state = useApi<{ profiles: RecurringJournalRow[] }>(() => recurringJournals.list(), []);
  const chart = useApi<{ accounts: AccountRow[] }>(() => accountsApi.list(), []);

  const [open, setOpen] = useState(false);
  const [f, setF] = useState(BLANK);
  // The profile being edited; null while making a new one.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const startEdit = (p: RecurringJournalRow) => {
    setEditingId(p.id);
    setF({ name: p.name, frequency: p.frequency, nextRun: p.nextRun, debitAccountId: p.debitAccountId, creditAccountId: p.creditAccountId, amount: p.amountPaise, memo: p.memo ?? '' });
    setOpen(true);
  };
  const startNew = () => { setEditingId(null); setF(BLANK); setOpen(true); };

  const create = useApiAction(recurringJournals.create);
  const run = useApiAction(recurringJournals.run);
  const toggle = useApiAction(recurringJournals.toggle);
  const auto = useApiAction(recurringJournals.auto);

  const busy = run.busy || toggle.busy || auto.busy;

  const accountChoices = (chart.data?.accounts ?? []).map((a) => ({
    value: a.id,
    label: a.name,
    sublabel: `${a.code} · ${a.type}`,
  }));

  const save = async () => {
    if (!f.name.trim() || !f.debitAccountId || !f.creditAccountId || f.amount <= 0) {
      toast.error('Fill in a name, both accounts and an amount.');
      return;
    }
    if (editingId) {
      setSaving(true);
      try {
        await api.put('/api/recurring-journals', {
          id: editingId, name: f.name.trim(), frequency: f.frequency, nextRun: f.nextRun,
          debitAccountId: f.debitAccountId, creditAccountId: f.creditAccountId, amountPaise: f.amount, memo: f.memo.trim() || f.name.trim(),
        });
        toast.success('Profile saved', { description: 'It posts this way from its next run; entries already posted stay as they are.' });
        setOpen(false); setEditingId(null); setF(BLANK);
        state.refetch();
      } catch (e) {
        toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
      } finally {
        setSaving(false);
      }
      return;
    }
    const result = await create.run({
      name: f.name.trim(),
      frequency: f.frequency,
      nextRun: f.nextRun,
      debitAccountId: f.debitAccountId,
      creditAccountId: f.creditAccountId,
      amountPaise: f.amount,
      memo: f.memo.trim() || f.name.trim(),
    });
    if (!result) {
      toast.error(create.error ?? 'The profile was not created');
      return;
    }
    toast.success('Recurring journal created', {
      description: 'Nothing posts until you run it — this is a template, not an entry.',
    });
    setOpen(false);
    setF(BLANK);
    state.refetch();
  };

  const runNow = async (p: RecurringJournalRow) => {
    const done = await run.run(p.id);
    if (!done) {
      toast.error(run.error ?? 'The entry was not posted');
      return;
    }
    toast.success(`JE #${done.entryNo} posted`, {
      description: `${p.name} — dated ${new Date(done.postedOn).toLocaleDateString('en-IN')}`,
    });
    state.refetch();
  };

  const setActive = async (p: RecurringJournalRow, active: boolean) => {
    const done = await toggle.run(p.id, active);
    if (!done) {
      toast.error(toggle.error ?? 'That could not be changed');
      return;
    }
    toast.info(active ? `${p.name} resumed` : `${p.name} paused`);
    state.refetch();
  };

  const setAuto = async (p: RecurringJournalRow, on: boolean) => {
    if (!(await auto.run(p.id, on))) {
      toast.error(auto.error ?? 'That could not be changed');
      return;
    }
    toast.info(on ? `${p.name} will post itself on its dates` : `${p.name} posts only when run`);
    state.refetch();
  };

  return (
    <>
      <PageHeader
        title="Recurring Journals"
        description="Entries that repeat unchanged — depreciation, amortisation, accruals. Set once, and post them on schedule with identical wording every period."
        actions={
          (canCreate || canEdit) && (
            <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setEditingId(null); }}>
              {canCreate && <Button size="sm" className="gap-1.5" onClick={startNew}><Plus className="size-4" /> New profile</Button>}
              <DialogContent data-slot="recurring-journal-dialog">
                <DialogHeader>
                  <DialogTitle>{editingId ? `Edit ${f.name || 'recurring journal'}` : 'New recurring journal'}</DialogTitle>
                  <FoldNav />
                  <DialogDescription>
                    Two accounts and one amount. The same entry posts each period, worded identically.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <Field label="Name" required error={create.fieldErrors.name}>
                    <Input
                      value={f.name}
                      onChange={(e) => setF({ ...f, name: e.target.value })}
                      placeholder="What this recurring entry is for"
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Frequency" required>
                      <Combobox
                        options={FREQUENCY}
                        value={f.frequency}
                        onChange={(v) => setF({ ...f, frequency: v })}
                        showAvatar={false}
                      />
                    </Field>
                    <Field label={editingId ? 'Next run' : 'First run'} required>
                      <Input
                        type="date"
                        value={f.nextRun}
                        onChange={(e) => setF({ ...f, nextRun: e.target.value })}
                      />
                    </Field>
                  </div>
                  <Field label="Debit account" required hint="What increases — usually the expense">
                    <Combobox
                      options={accountChoices}
                      value={f.debitAccountId}
                      onChange={(v) => setF({ ...f, debitAccountId: v })}
                      placeholder="Select account"
                      searchPlaceholder="Search accounts by name or code"
                      showAvatar={false}
                    />
                  </Field>
                  <Field label="Credit account" required hint="What decreases — the asset or the liability">
                    <Combobox
                      options={accountChoices}
                      value={f.creditAccountId}
                      onChange={(v) => setF({ ...f, creditAccountId: v })}
                      placeholder="Select account"
                      searchPlaceholder="Search accounts by name or code"
                      showAvatar={false}
                    />
                  </Field>
                  <Field label="Amount" required>
                    <MoneyInput valuePaise={f.amount} onChangePaise={(p) => setF({ ...f, amount: p })} />
                  </Field>
                  <Field label="Narration" hint="Defaults to the profile name">
                    <Input
                      value={f.memo}
                      onChange={(e) => setF({ ...f, memo: e.target.value })}
                      placeholder="Line narration"
                    />
                  </Field>
                  {create.error && <p className="text-sm text-destructive">{create.error}</p>}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => { setOpen(false); setEditingId(null); }}>Cancel</Button>
                  <Button onClick={save} disabled={create.busy || saving} data-slot="recurring-journal-save">
                    {create.busy || saving ? 'Saving…' : editingId ? 'Save' : 'Create profile'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )
        }
      />

      <AsyncPage state={state}>
        {(d) =>
          d.profiles.length === 0 ? (
            <EmptyState
              icon={Repeat}
              title="No recurring journals"
              description="Set one up for anything you post identically every month — depreciation is the usual first one."
            />
          ) : (
            <div className="space-y-3">
              {d.profiles.map((p) => (
                <Card
                  key={p.id}
                  className={cn(
                    'flex flex-wrap items-center gap-4 p-4',
                    !p.isActive && 'opacity-60',
                    p.isDue && p.isActive && 'border-amber-500/40',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">{p.name}</p>
                      <Badge variant="secondary" className="text-[10px] capitalize">{p.frequency}</Badge>
                      {p.isDue && p.isActive && (
                        <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-700 dark:text-amber-300">
                          Due
                        </Badge>
                      )}
                      {!p.isActive && <Badge variant="outline" className="text-[10px]">Paused</Badge>}
                      {p.autoRun && p.isActive && <Badge variant="outline" className="text-[10px]">Posts itself</Badge>}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Dr {p.debitCode} {p.debitName} · Cr {p.creditCode} {p.creditName}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <CalendarClock className="size-3" />
                      Next {short(p.nextRun)}
                      {p.lastPostedAt ? ` · last posted ${short(p.lastPostedAt)}` : ' · never posted'}
                    </p>
                    {p.lastError && p.autoRun && <p className="mt-1 text-xs text-destructive">{p.lastError}</p>}
                  </div>

                  <Money value={p.amountPaise} className="shrink-0 text-lg font-semibold" />

                  {canCreate && (
                    <div className="flex shrink-0 items-center gap-2">
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        Active
                        <Switch
                          checked={p.isActive}
                          disabled={busy}
                          onCheckedChange={(v) => void setActive(p, v)}
                        />
                      </label>
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Post on its dates without anyone pressing Run now">
                        Automatic
                        <Switch checked={p.autoRun} disabled={busy || !p.isActive} onCheckedChange={(v) => void setAuto(p, v)} />
                      </label>
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        disabled={busy || !p.isActive}
                        onClick={() => void runNow(p)}
                      >
                        <Play className="size-3.5" /> Run now
                      </Button>
                      <RowActions
                        label={p.name}
                        canEdit={canEdit}
                        canDelete={canDelete}
                        onEdit={() => startEdit(p)}
                        onDelete={async (reason) => { await api.delete(withReason(`/api/recurring-journals?id=${encodeURIComponent(p.id)}`, reason)); state.refetch(); }}
                        done={`${p.name} deleted`}
                        deleteTitle={`Delete the recurring journal ${p.name}?`}
                        deleteDescription="The profile goes and nothing more is posted from it. Entries it already posted are real and stay in the ledger."
                      />
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )
        }
      </AsyncPage>

      <Card className="flex items-start gap-3 p-4">
        <Repeat className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          Running a profile posts one entry and moves the schedule forward by one period. Switch on Automatic and the
          scheduler does that on the day, in a locked period it waits and says why. Neither catches up on missed
          periods — silently posting six months of depreciation because nobody opened this screen since March is not
          a favour to anyone.
        </p>
      </Card>
    </>
  );
}
