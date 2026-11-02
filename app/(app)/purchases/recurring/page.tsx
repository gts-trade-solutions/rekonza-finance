'use client';

// Recurring bills and recurring expenses: the rent bill that comes every
// month, the subscription charged to the card on the 5th. Each profile raises
// its bill or records its expense through the same path a person would, by
// "Run now" or, when set, on its date by the scheduler. Nothing is caught up:
// a profile more than a period behind is left for someone to look at.

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

export default function RecurringPurchasesPage() {
  const router = useRouter();
  const canCreate = usePermission('purchases', 'create');
  const state = useApi(() => recurringPurchases.list(), []);
  const masters = useApi<Masters>(() => api.get('/api/masters'), []);
  const [kind, setKind] = useState<'bill' | 'expense' | null>(null);
  const [f, setF] = useState(BLANK);

  const create = useApiAction(recurringPurchases.create);
  const run = useApiAction(recurringPurchases.run);
  const toggle = useApiAction(recurringPurchases.toggle);
  const auto = useApiAction(recurringPurchases.auto);
  const remove = useApiAction(recurringPurchases.remove);
  const busy = run.busy || toggle.busy || auto.busy || remove.busy;

  const accounts = useMemo(() => (masters.data?.accounts ?? []).filter((a) => a.type === 'expense')
    .map((a) => ({ value: a.id, label: a.name, sublabel: a.code })), [masters.data]);
  const banks = useMemo(() => (masters.data?.bankAccounts ?? []).map((b) => ({ value: b.id, label: b.name, sublabel: b.kind })), [masters.data]);

  const save = async () => {
    if (!kind) return;
    if (!f.name.trim() || !f.accountId || f.amount <= 0) {
      toast.error('Name the profile, pick what it is booked to, and set an amount.');
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
        ? { lines: [{ accountId: f.accountId, description: f.description || f.name.trim(), qty: 1, ratePaise: f.amount, gstRatePct: f.gst }] }
        : { expense: { accountId: f.accountId, paidThroughBankAccountId: f.paidThroughId, amountPaise: f.amount, gstRatePct: f.gst, notes: f.description || null } }),
    });
    if (!done) { toast.error(create.error ?? 'The profile was not created'); return; }
    toast.success('Recurring profile created', { description: f.autoRun ? 'It runs on its dates by itself.' : 'Nothing is raised until you run it.' });
    setKind(null);
    setF(BLANK);
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
                  <Button size="icon-sm" variant="ghost" aria-label={`Delete ${p.name}`} disabled={busy}
                    onClick={() => act(() => remove.run(p.id), `${p.name} deleted; what it raised stays`, () => remove.error)}>
                    <Trash2 className="size-4" />
                  </Button>
                </>
              )}
            </div>
          </div>
        </Card>
      ))}
    </div>
  ) : (
    <EmptyState icon={Repeat} title={k === 'bill' ? 'No recurring bills' : 'No recurring expenses'}
      description={k === 'bill' ? 'Rent, maintenance, an annual contract: a bill that comes on a schedule.' : 'A subscription or a standing charge paid on a schedule.'}
      action={canCreate ? <Button size="sm" onClick={() => setKind(k)}><Plus className="size-4" /> New recurring {k}</Button> : undefined} />
  );

  return (
    <>
      <PageHeader
        title="Recurring Bills & Expenses"
        description="Bills and expenses that come on a schedule, raised the same way you would raise them by hand."
        actions={canCreate ? (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setKind('expense')} className="gap-1.5"><Plus className="size-4" /> Recurring expense</Button>
            <Button size="sm" onClick={() => setKind('bill')} className="gap-1.5"><Plus className="size-4" /> Recurring bill</Button>
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

      <Dialog open={!!kind} onOpenChange={(o) => !o && setKind(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{kind === 'bill' ? 'New recurring bill' : 'New recurring expense'}</DialogTitle>
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
            <Field label="Booked to" required className="sm:col-span-2">
              <Combobox options={accounts} value={f.accountId} onChange={(v) => setF({ ...f, accountId: v })} placeholder="Expense account" showAvatar={false} />
            </Field>
            <Field label={kind === 'bill' ? 'Amount before GST' : 'Amount paid'} required hint={kind === 'bill' ? 'GST is added on top' : 'Including GST; the tax is taken out of it'}>
              <MoneyInput valuePaise={f.amount} onChangePaise={(p) => setF({ ...f, amount: p })} />
            </Field>
            <Field label="GST rate">
              <Combobox options={GST} value={String(f.gst)} onChange={(v) => setF({ ...f, gst: Number(v) })} showAvatar={false} />
            </Field>
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
            <Field label="Description" className="sm:col-span-2">
              <Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="What it is for" />
            </Field>
            <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm sm:col-span-2">
              <span>Run on its dates by itself<span className="block text-xs text-muted-foreground">Off: it waits for you to press Run now.</span></span>
              <Switch checked={f.autoRun} onCheckedChange={(v) => setF({ ...f, autoRun: v })} />
            </label>
          </div>
          {create.error && <p className="text-sm text-destructive">{create.error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setKind(null)}>Cancel</Button>
            <Button onClick={save} disabled={create.busy}>{create.busy ? 'Saving…' : 'Create profile'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
