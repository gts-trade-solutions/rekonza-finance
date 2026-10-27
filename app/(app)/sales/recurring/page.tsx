'use client';

// Recurring invoices — contracts that bill themselves.
//
// Each profile stores the lines as written, with their own rates, rather than
// as item ids resolved at generation time. Resolving later would silently
// re-price a two-year-old contract the moment somebody updated a catalogue
// price, and the customer would get an invoice nobody agreed to.
//
// Running a profile goes through the same createInvoice as a hand-typed sale,
// so the GST, the numbering and the posting are identical.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, Mail, Play, Plus, Repeat, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import { ContactPicker } from '@/components/forms/quick-create';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { recurringInvoices, type RecurringInvoiceRow } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { usePermission } from '@/lib/store/hooks';
import { itemOptions } from '@/lib/options';
import { cn } from '@/lib/utils';

const FREQUENCY = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
];

const TERMS = [
  { value: 'due_on_receipt', label: 'Due on receipt' },
  { value: 'net_15', label: 'Net 15' },
  { value: 'net_30', label: 'Net 30' },
  { value: 'net_45', label: 'Net 45' },
];

/**
 * Dunning schedules are configuration for a mailer that is not built yet — the
 * app sends no email. Shown as the surface it will occupy, and flagged as such
 * rather than pretending to save.
 */
const REMINDERS = [
  { id: 'r1', label: '3 days before due', template: 'Friendly reminder' },
  { id: 'r2', label: 'On the due date', template: 'Payment due today' },
  { id: 'r3', label: '7 days overdue', template: 'Overdue — first notice' },
  { id: 'r4', label: '15 days overdue', template: 'Overdue — second notice' },
  { id: 'r5', label: '30 days overdue', template: 'Final notice before escalation' },
];

const today = () => new Date().toISOString().slice(0, 10);
const short = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN') : '—');

const BLANK = {
  name: '', customerId: '', frequency: 'monthly', startDate: today(),
  paymentTerms: 'net_30', autoSend: false,
  itemId: '', qty: 1, rate: 0, gstRatePct: 18,
};

export default function RecurringPage() {
  const router = useRouter();
  const canCreate = usePermission('sales', 'create');
  const items = useAppStore((s) => s.items);

  const state = useApi<{ profiles: RecurringInvoiceRow[] }>(() => recurringInvoices.list(), []);

  const [open, setOpen] = useState(false);
  const [f, setF] = useState(BLANK);

  const create = useApiAction(recurringInvoices.create);
  const run = useApiAction(recurringInvoices.run);
  const toggle = useApiAction(recurringInvoices.toggle);
  const auto = useApiAction(recurringInvoices.auto);
  const remove = useApiAction(recurringInvoices.remove);
  const busy = run.busy || toggle.busy || auto.busy || remove.busy;

  const save = async () => {
    if (!f.name.trim() || !f.customerId || f.rate <= 0) {
      toast.error('Name the profile, pick a customer, and set a rate.');
      return;
    }
    const picked = items.find((i) => i.id === f.itemId);
    const done = await create.run({
      name: f.name.trim(),
      customerId: f.customerId,
      frequency: f.frequency,
      startDate: f.startDate,
      paymentTerms: f.paymentTerms,
      autoSend: f.autoSend,
      lines: [{
        itemId: f.itemId || null,
        description: picked?.name ?? f.name.trim(),
        qty: f.qty,
        ratePaise: f.rate,
        gstRatePct: f.gstRatePct,
        hsnSac: picked?.hsnSac ?? null,
      }],
    });
    if (!done) {
      toast.error(create.error ?? 'The profile was not created');
      return;
    }
    toast.success('Recurring profile created', {
      description: 'Nothing is billed until it runs — this is a template, not an invoice.',
    });
    setOpen(false);
    setF(BLANK);
    state.refetch();
  };

  const runNow = async (p: RecurringInvoiceRow) => {
    const done = await run.run(p.id);
    if (!done) {
      toast.error(run.error ?? 'The invoice was not raised');
      return;
    }
    toast.success(`Invoice ${done.number} raised`, {
      description: done.autoSent ? 'Marked sent automatically.' : 'Left for you to review before sending.',
    });
    state.refetch();
    router.push(`/sales/invoices/${done.invoiceId}`);
  };

  const setActive = async (p: RecurringInvoiceRow, active: boolean) => {
    const done = await toggle.run(p.id, active);
    if (!done) {
      toast.error(toggle.error ?? 'That could not be changed');
      return;
    }
    toast.info(active ? 'Recurring profile resumed' : 'Recurring profile paused');
    state.refetch();
  };

  const setAuto = async (p: RecurringInvoiceRow, on: boolean) => {
    if (!(await auto.run(p.id, on))) {
      toast.error(auto.error ?? 'That could not be changed');
      return;
    }
    toast.info(on ? `${p.name} will be raised on its dates` : `${p.name} is raised only by hand`);
    state.refetch();
  };

  const drop = async (p: RecurringInvoiceRow) => {
    const done = await remove.run(p.id);
    if (!done) {
      toast.error(remove.error ?? 'The profile was not deleted');
      return;
    }
    toast.info(`${p.name} deleted`, { description: 'Invoices it already raised are unaffected.' });
    state.refetch();
  };

  return (
    <>
      <PageHeader
        title="Recurring & reminders"
        description="Invoices that raise themselves, and reminders that chase payment without you having to."
        actions={
          canCreate && (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="gap-1.5"><Plus className="size-4" /> New profile</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>New recurring invoice</DialogTitle>
                  <DialogDescription>
                    The rate is stored as you set it here. It will not move when the catalogue price does — a
                    contract is a contract.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <Field label="Profile name" required error={create.fieldErrors.name}>
                    <Input
                      value={f.name}
                      onChange={(e) => setF({ ...f, name: e.target.value })}
                      placeholder="What the retainer covers"
                    />
                  </Field>
                  <Field label="Customer" required>
                    <ContactPicker
                      kind="customer"
                      value={f.customerId}
                      onChange={(v) => setF({ ...f, customerId: v })}
                      canCreate={canCreate}
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
                    <Field label="First run" required>
                      <Input
                        type="date"
                        value={f.startDate}
                        onChange={(e) => setF({ ...f, startDate: e.target.value })}
                      />
                    </Field>
                  </div>
                  <Field label="Item" hint="Optional — leave blank to bill the profile name as a single line">
                    <Combobox
                      options={itemOptions({ items } as never)}
                      value={f.itemId}
                      onChange={(v) => {
                        const picked = items.find((i) => i.id === v);
                        setF({
                          ...f,
                          itemId: v,
                          rate: picked?.salePricePaise ?? f.rate,
                          gstRatePct: picked?.gstRatePct ?? f.gstRatePct,
                        });
                      }}
                      placeholder="No item"
                      searchPlaceholder="Search items"
                      showAvatar={false}
                      clearable
                    />
                  </Field>
                  <div className="grid grid-cols-3 gap-4">
                    <Field label="Quantity">
                      <Input
                        type="number"
                        min="1"
                        value={f.qty}
                        onChange={(e) => setF({ ...f, qty: Math.max(1, Number(e.target.value) || 1) })}
                      />
                    </Field>
                    <Field label="Rate" required>
                      <MoneyInput valuePaise={f.rate} onChangePaise={(p) => setF({ ...f, rate: p })} />
                    </Field>
                    <Field label="Terms">
                      <Combobox
                        options={TERMS}
                        value={f.paymentTerms}
                        onChange={(v) => setF({ ...f, paymentTerms: v })}
                        showAvatar={false}
                      />
                    </Field>
                  </div>
                  <div className="flex items-start justify-between gap-3 rounded-md border p-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">Send automatically</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Off means each generated invoice waits for you to review it before it goes out.
                      </p>
                    </div>
                    <Switch checked={f.autoSend} onCheckedChange={(v) => setF({ ...f, autoSend: v })} />
                  </div>
                  {create.error && <p className="text-sm text-destructive">{create.error}</p>}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button onClick={save} disabled={create.busy}>
                    {create.busy ? 'Saving…' : 'Create profile'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )
        }
      />

      <Tabs defaultValue="recurring">
        <TabsList>
          <TabsTrigger value="recurring">Recurring invoices</TabsTrigger>
          <TabsTrigger value="dunning">Payment reminders</TabsTrigger>
        </TabsList>

        <TabsContent value="recurring" className="mt-4 space-y-3">
          <AsyncPage state={state}>
            {(d) =>
              d.profiles.length === 0 ? (
                <EmptyState
                  icon={Repeat}
                  title="No recurring profiles"
                  description="Set one up for a contract that bills the same amount every month."
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
                          <p className="font-medium">{p.customerName}</p>
                          <Badge variant="secondary" className="text-[10px] capitalize">{p.frequency}</Badge>
                          <Badge variant="outline" className="text-[10px]">
                            {p.autoSend ? 'Auto-send' : 'Save as draft'}
                          </Badge>
                          {p.autoRun && p.isActive && <Badge variant="outline" className="text-[10px]">Raises itself</Badge>}
                          {p.isDue && p.isActive && (
                            <Badge
                              variant="outline"
                              className="border-amber-500/40 text-[10px] text-amber-700 dark:text-amber-300"
                            >
                              Due
                            </Badge>
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">{p.name}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {p.lastGeneratedAt ? `Last raised ${short(p.lastGeneratedAt)}` : 'Never raised'}
                        </p>
                        {p.lastError && p.autoRun && <p className="mt-1 text-xs text-destructive">{p.lastError}</p>}
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-muted-foreground">Next run</p>
                        <p className="text-sm font-medium">{short(p.nextRun)}</p>
                      </div>
                      <Money value={p.totalPaise} className="w-28 font-medium" />
                      {canCreate && (
                        <div className="flex items-center gap-2">
                          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        Active
                        <Switch
                          checked={p.isActive}
                          disabled={busy}
                          onCheckedChange={(v) => void setActive(p, v)}
                        />
                      </label>
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Raise on its dates without anyone pressing Raise now">
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
                            <Play className="size-3.5" /> Raise now
                          </Button>
                          <button
                            type="button"
                            aria-label={`Delete ${p.name}`}
                            disabled={busy}
                            onClick={() => void drop(p)}
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

          <Card className="flex items-start gap-3 border-dashed p-4">
            <Repeat className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Raising a profile creates a real invoice through the same path as a typed one — current GST rules, the
              next number in the series, a balanced journal entry — and moves the schedule forward one period. With
              Automatic on, the scheduler raises it on the day. Neither catches up on periods that were missed.
            </p>
          </Card>
        </TabsContent>

        <TabsContent value="dunning" className="mt-4 space-y-3">
          <Card className="flex items-start gap-3 border-amber-500/30 bg-amber-500/5 p-4">
            <Mail className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-xs leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">Reminders do not send yet.</span> The app has no mail
              transport wired up, so this is the shape the schedule will take rather than something that runs. The
              ageing report is what to work from in the meantime.
            </p>
          </Card>

          {REMINDERS.map((r) => (
            <Card key={r.id} className="flex flex-wrap items-center gap-4 p-4 opacity-70">
              <Bell className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{r.label}</p>
                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Mail className="size-3" /> Template: {r.template}
                </p>
              </div>
              <Switch checked={false} disabled />
            </Card>
          ))}
        </TabsContent>
      </Tabs>
    </>
  );
}
