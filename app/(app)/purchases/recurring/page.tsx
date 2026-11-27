'use client';

// Recurring bills and recurring expenses: the rent bill that comes every
// month, the subscription charged to the card on the 5th. Each profile raises
// its bill or records its expense through the same path a person would, by
// "Run now" or, when set, on its date by the scheduler. Nothing is caught up:
// a profile more than a period behind is left for someone to look at.

import { FoldNav } from '@/components/layout/nav-state';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Play, Plus, Repeat, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { ContactPicker } from '@/components/forms/quick-create';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { api, recurringPurchases, type RecurringPurchaseRow } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { DeleteConfirmDialog, RowActions } from '@/components/shared/row-actions';

const FREQUENCY = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
];
const GST = [0, 5, 12, 18, 28].map((r) => ({ value: String(r), label: `${r}%` }));
const today = () => new Date().toISOString().slice(0, 10);
const short = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN') : '—');

interface Masters {
  accounts: { id: string; code: string; name: string; type: string }[];
  bankAccounts: { id: string; name: string; kind: string }[];
}

const BLANK = {
  name: '', vendorId: '', frequency: 'monthly', startDate: today(), endDate: '', dueDays: 30, autoRun: true,
  accountId: '', description: '', amount: 0, gst: 18, paidThroughId: '',
};

/** A recurring bill's line: what it is booked to, its words, and the amount before GST. */
interface BillLine { key: string; itemId: string | null; accountId: string; description: string; qty: number; ratePaise: number; gstRatePct: number; hsnSac: string | null }
const newLine = (): BillLine => ({ key: `n${Math.random().toString(36).slice(2)}`, itemId: null, accountId: '', description: '', qty: 1, ratePaise: 0, gstRatePct: 18, hsnSac: null });

export default function RecurringPurchasesPage() {
  const router = useRouter();
  const canCreate = usePermission('purchases', 'create');
  const canEdit = usePermission('purchases', 'edit');
  const canDelete = usePermission('purchases', 'void');
  const state = useApi(() => recurringPurchases.list(), []);
  const masters = useApi<Masters>(() => api.get('/api/masters'), []);
  const [kind, setKind] = useState<'bill' | 'expense' | null>(null);
  const [f, setF] = useState(BLANK);
  const [lines, setLines] = useState<BillLine[]>([newLine()]);
  // Zoho's Edit (the same window, filled with the profile) and Delete (asked once).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<RecurringPurchaseRow | null>(null);
  const setLine = (key: string, patch: Partial<BillLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const openNew = (k: 'bill' | 'expense') => { setEditingId(null); setF(BLANK); setLines([newLine()]); setKind(k); };
  const startEdit = (p: RecurringPurchaseRow) => {
    setEditingId(p.id);
    setF({
      name: p.name, vendorId: p.vendorId ?? '', frequency: p.frequency, startDate: p.startDate, endDate: p.endDate ?? '', dueDays: p.dueDays,
      autoRun: p.autoRun, accountId: p.expense?.accountId ?? '', description: p.expense?.notes ?? '', amount: p.expense?.amountPaise ?? 0,
      gst: p.expense?.gstRatePct ?? 18, paidThroughId: p.expense?.paidThroughBankAccountId ?? '',
    });
    setLines((p.lines ?? []).map((l, i) => ({
      key: `l${i}`, itemId: l.itemId, accountId: l.accountId ?? '', description: l.description ?? '', qty: l.qty, ratePaise: l.ratePaise, gstRatePct: l.gstRatePct, hsnSac: l.hsnSac,
    })));
    setKind(p.kind);
  };
  const close = () => { setKind(null); setEditingId(null); };

  const create = useApiAction((input: unknown) => (editingId ? recurringPurchases.update(editingId, input) : recurringPurchases.create(input)));
  const run = useApiAction(recurringPurchases.run);
  const toggle = useApiAction(recurringPurchases.toggle);
  const auto = useApiAction(recurringPurchases.auto);
  const busy = run.busy || toggle.busy || auto.busy;

  const accounts = useMemo(() => (masters.data?.accounts ?? []).filter((a) => a.type === 'expense')
    .map((a) => ({ value: a.id, label: a.name, sublabel: a.code })), [masters.data]);
  const banks = useMemo(() => (masters.data?.bankAccounts ?? []).map((b) => ({ value: b.id, label: b.name, sublabel: b.kind })), [masters.data]);

  const save = async () => {
    if (!kind) return;
    if (!f.name.trim()) { toast.error('Name the profile.'); return; }
    if (kind === 'bill' && (!lines.length || lines.some((l) => (!l.accountId && !l.itemId) || l.ratePaise <= 0))) {
      toast.error('Each line needs what it is booked to and an amount.');
      return;
    }
    if (kind === 'expense' && (!f.accountId || f.amount <= 0)) {
      toast.error('Pick what it is booked to, and set an amount.');
      return;
    }
    if (kind === 'bill' && !f.vendorId) { toast.error('A recurring bill needs the vendor it comes from.'); return; }
    if (kind === 'expense' && !f.paidThroughId) { toast.error('Pick the account it is paid from.'); return; }
    const done = await create.run({
      kind,
      name: f.name.trim(),
      vendorId: f.vendorId || null,
      frequency: f.frequency,
      startDate: f.startDate,
      endDate: f.endDate || null,
      dueDays: f.dueDays,
      autoRun: f.autoRun,
      ...(kind === 'bill'
        ? { lines: lines.map((l) => ({ itemId: l.itemId, accountId: l.accountId || null, description: l.description || f.name.trim(), qty: l.qty, ratePaise: l.ratePaise, gstRatePct: l.gstRatePct, hsnSac: l.hsnSac })) }
        : { expense: { accountId: f.accountId, paidThroughBankAccountId: f.paidThroughId, amountPaise: f.amount, gstRatePct: f.gst, notes: f.description || null } }),
    });
    if (!done) { toast.error(editingId ? 'Not saved' : 'The profile was not created', { description: create.error ?? undefined }); return; }
    toast.success(editingId ? `${f.name.trim()} saved` : 'Recurring profile created', {
      description: editingId ? 'Its next runs raise it as it is now; what it raised already stays as it was.'
        : f.autoRun ? 'It runs on its dates by itself.' : 'Nothing is raised until you run it.',
    });
    close();
    setF(BLANK);
    setLines([newLine()]);
    state.refetch();
  };

  const runNow = async (p: RecurringPurchaseRow) => {
    const done = await run.run(p.id);
    if (!done) { toast.error(run.error ?? 'Nothing was raised'); return; }
    toast.success(`${done.kind === 'bill' ? 'Bill' : 'Expense'} ${done.number} raised`);
    state.refetch();
    if (done.kind === 'bill') router.push(`/purchases/bills/${done.docId}`);
  };
  const act = async (fn: () => Promise<unknown>, ok: string, err: () => string | null) => {
    if (!(await fn())) { toast.error(err() ?? 'That could not be changed'); return; }
    toast.info(ok);
    state.refetch();
  };

  const list = (rows: RecurringPurchaseRow[], k: 'bill' | 'expense') => rows.length ? (
    <div className="grid gap-3">
      {rows.map((p) => (
        <Card key={p.id} className="p-4" data-slot="recurring-purchase">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-2 font-medium">
                <Repeat className="size-4 text-muted-foreground" /> {p.name}
                {!p.isActive && <Badge variant="secondary" className="text-[10px]">Paused</Badge>}
                {p.isDue && <Badge variant="outline" className="border-warning/50 text-[10px]">Due</Badge>}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {[p.vendorName, p.paidThrough && `paid from ${p.paidThrough}`, `${p.frequency}`, `next ${short(p.nextRun)}`,
                  p.lastGeneratedAt && `last ${short(p.lastGeneratedAt)}`, p.endDate && `ends ${short(p.endDate)}`].filter(Boolean).join(' · ')}
              </p>
              {p.lastError && <p className="mt-1 text-xs text-destructive">{p.lastError}</p>}
            </div>
            <div className="flex items-center gap-3">
              <Money value={p.totalPaise} className="font-semibold" />
              {canCreate && (
                <>
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Switch checked={p.autoRun} disabled={busy}
                      onCheckedChange={(on) => act(() => auto.run(p.id, on), on ? `${p.name} runs on its dates` : `${p.name} runs only by hand`, () => auto.error)} />
                    On its dates
                  </label>
                  <Button size="sm" variant="outline" disabled={busy || !p.isActive} onClick={() => runNow(p)} className="gap-1">
                    <Play className="size-3.5" /> Run now
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy}
                    onClick={() => act(() => toggle.run(p.id, !p.isActive), p.isActive ? 'Paused' : 'Resumed', () => toggle.error)}>
                    {p.isActive ? 'Pause' : 'Resume'}
                  </Button>
                </>
              )}
              <RowActions onEdit={canEdit ? () => startEdit(p) : null} onDelete={canDelete ? () => setDeleting(p) : null}
                editTitle={`Edit ${p.name}`} deleteTitle={`Delete ${p.name}`} />
            </div>
          </div>
        </Card>
      ))}
    </div>
  ) : (
    <EmptyState icon={Repeat} title={k === 'bill' ? 'No recurring bills' : 'No recurring expenses'}
      description={k === 'bill' ? 'Rent, maintenance, an annual contract: a bill that comes on a schedule.' : 'A subscription or a standing charge paid on a schedule.'}
      action={canCreate ? <Button size="sm" onClick={() => openNew(k)}><Plus className="size-4" /> New recurring {k}</Button> : undefined} />
  );

  return (
    <>
      <PageHeader
        title="Recurring Bills & Expenses"
        description="Bills and expenses that come on a schedule, raised the same way you would raise them by hand."
        actions={canCreate ? (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => openNew('expense')} className="gap-1.5"><Plus className="size-4" /> Recurring expense</Button>
            <Button size="sm" onClick={() => openNew('bill')} className="gap-1.5"><Plus className="size-4" /> Recurring bill</Button>
          </div>
        ) : undefined}
      />
      <AsyncPage state={state}>
        {(d) => (
          <Tabs defaultValue="bill">
            <TabsList>
              <TabsTrigger value="bill">Bills ({d.profiles.filter((p) => p.kind === 'bill').length})</TabsTrigger>
              <TabsTrigger value="expense">Expenses ({d.profiles.filter((p) => p.kind === 'expense').length})</TabsTrigger>
            </TabsList>
            <TabsContent value="bill" className="mt-4">{list(d.profiles.filter((p) => p.kind === 'bill'), 'bill')}</TabsContent>
            <TabsContent value="expense" className="mt-4">{list(d.profiles.filter((p) => p.kind === 'expense'), 'expense')}</TabsContent>
          </Tabs>
        )}
      </AsyncPage>

      <DeleteConfirmDialog
        open={!!deleting} onOpenChange={(v) => { if (!v) setDeleting(null); }}
        title={`Delete ${deleting?.name ?? 'this profile'}?`}
        description={`The profile stops and is removed. The ${deleting?.kind === 'bill' ? 'bills' : 'expenses'} it already raised stay as they are, each with its own Edit and Delete.`}
        doneMessage={`${deleting?.name ?? 'Profile'} deleted; what it raised stays`}
        onConfirm={(reason) => recurringPurchases.remove(deleting!.id, reason)}
        onDone={() => void state.refetch()}
      />

      <Dialog open={!!kind} onOpenChange={(o) => !o && close()}>
        <DialogContent className={kind === 'bill' ? 'max-w-2xl' : 'max-w-lg'} data-slot="recurring-dialog">
          <DialogHeader>
            <DialogTitle>{editingId ? `Edit ${f.name || 'profile'}` : kind === 'bill' ? 'New recurring bill' : 'New recurring expense'}</DialogTitle>
            <FoldNav />
            <DialogDescription>
              {kind === 'bill'
                ? 'Each run raises a bill from the vendor, with a placeholder for their bill number to replace when their bill arrives.'
                : 'Each run records the expense as paid from the account you pick.'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Profile name" required className="sm:col-span-2" error={create.fieldErrors.name}>
              <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={kind === 'bill' ? 'Office rent' : 'Internet'} />
            </Field>
            <Field label="Vendor" required={kind === 'bill'} className="sm:col-span-2">
              <ContactPicker kind="vendor" value={f.vendorId} onChange={(v) => setF({ ...f, vendorId: v })} placeholder={kind === 'bill' ? 'Who bills it' : 'Optional'} canCreate={canCreate} />
            </Field>
            {kind === 'bill' ? (
              <div className="space-y-2 sm:col-span-2" data-slot="recurring-lines">
                <p className="text-sm font-medium">Lines <span className="text-xs font-normal text-muted-foreground">· amounts before GST; GST is added on top</span></p>
                {lines.map((l) => (
                  <div key={l.key} className="grid gap-2 rounded-md border p-2 sm:grid-cols-[1.4fr_1.4fr_1fr_90px_auto]" data-slot="recurring-line">
                    <Combobox options={accounts} value={l.accountId} onChange={(v) => setLine(l.key, { accountId: v })} placeholder={l.itemId ? 'From the item' : 'Expense account'} showAvatar={false} />
                    <Input value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} placeholder="What it is for" />
                    <MoneyInput valuePaise={l.ratePaise} onChangePaise={(v) => setLine(l.key, { ratePaise: v })} />
                    <Combobox options={GST} value={String(l.gstRatePct)} onChange={(v) => setLine(l.key, { gstRatePct: Number(v) })} showAvatar={false} />
                    <Button size="icon-sm" variant="ghost" aria-label="Remove line" disabled={lines.length < 2} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><Trash2 className="size-4" /></Button>
                  </div>
                ))}
                <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => setLines((ls) => [...ls, newLine()])}><Plus className="size-3.5" /> Add line</Button>
              </div>
            ) : (
              <>
                <Field label="Booked to" required className="sm:col-span-2">
                  <Combobox options={accounts} value={f.accountId} onChange={(v) => setF({ ...f, accountId: v })} placeholder="Expense account" showAvatar={false} />
                </Field>
                <Field label="Amount paid" required hint="Including GST; the tax is taken out of it">
                  <MoneyInput valuePaise={f.amount} onChangePaise={(p) => setF({ ...f, amount: p })} />
                </Field>
                <Field label="GST rate">
                  <Combobox options={GST} value={String(f.gst)} onChange={(v) => setF({ ...f, gst: Number(v) })} showAvatar={false} />
                </Field>
              </>
            )}
            {kind === 'expense' && (
              <Field label="Paid from" required className="sm:col-span-2">
                <Combobox options={banks} value={f.paidThroughId} onChange={(v) => setF({ ...f, paidThroughId: v })} placeholder="Bank, cash or card" showAvatar={false} />
              </Field>
            )}
            <Field label="Repeats">
              <Combobox options={FREQUENCY} value={f.frequency} onChange={(v) => setF({ ...f, frequency: v })} showAvatar={false} />
            </Field>
            {kind === 'bill' ? (
              <Field label="Due after (days)">
                <Input type="number" min={0} value={f.dueDays} onChange={(e) => setF({ ...f, dueDays: Number(e.target.value) || 0 })} />
              </Field>
            ) : <div />}
            <Field label="First run">
              <Input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
            </Field>
            <Field label="Ends" hint="Optional">
              <Input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
            </Field>
            {kind === 'expense' && (
              <Field label="Description" className="sm:col-span-2">
                <Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="What it is for" />
              </Field>
            )}
            <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm sm:col-span-2">
              <span>Run on its dates by itself<span className="block text-xs text-muted-foreground">Off: it waits for you to press Run now.</span></span>
              <Switch checked={f.autoRun} onCheckedChange={(v) => setF({ ...f, autoRun: v })} />
            </label>
          </div>
          {create.error && <p className="text-sm text-destructive">{create.error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={close}>Cancel</Button>
            <Button onClick={save} disabled={create.busy} data-slot="recurring-save">{create.busy ? 'Saving…' : editingId ? 'Save' : 'Create profile'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
