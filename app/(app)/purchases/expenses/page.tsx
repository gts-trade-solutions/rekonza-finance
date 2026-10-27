'use client';

// Expenses, from the database.
//
// This page fetches its own accounts and bank accounts rather than reading the
// store's. Those two collections are still the seeded local ones, because the
// ledger and banking screens have not migrated and their rows reference the old
// ids — so a page that needs the server's ids asks for them directly.

import { useMemo, useState } from 'react';
import { Plus, Receipt, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { toastWarnings } from '@/lib/api/warnings';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Combobox } from '@/components/ui/combobox';
import { ContactPicker } from '@/components/forms/quick-create';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage, LoadingRows, Refreshing } from '@/components/shared/async-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { usePermission } from '@/lib/store/hooks';
import { useSession } from '@/components/layout/session-provider';
import { ALL_TIME, type RangeValue } from '@/lib/date-range';
import { today } from '@/lib/selectors';
import { formatINRCompact } from '@/lib/money';
import { GST_RATES } from '@/lib/tax/gst';
import { api, expenses as expenseApi, type ExpenseListItem } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { CostCentrePicker } from '@/components/forms/cost-centre-picker';

interface ExpenseMasters {
  accounts: { id: string; code: string; name: string; type: string }[];
  bankAccounts: { id: string; name: string; kind: string }[];
  contacts: { id: string; kind: string; displayName: string }[];
}

const BLANK = {
  accountId: '',
  vendorId: '',
  paidThroughId: '',
  amount: 0,
  gst: 18,
  notes: '',
  reference: '',
  billable: false,
  itcEligibility: 'eligible' as 'eligible' | 'ineligible' | 'capital_goods',
};

export default function ExpensesPage() {
  const canCreate = usePermission('purchases', 'create');
  const session = useSession();

  const [range, setRange] = useState<RangeValue>(() => ({ ...ALL_TIME, mode: 'all' }));
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(BLANK);
  const [costCentreId, setCostCentreId] = useState('');

  const state = useApi(
    () =>
      expenseApi.list({
        from: range.mode === 'all' ? undefined : range.from,
        to: range.mode === 'all' ? undefined : range.to,
        limit: 500,
      }),
    [range.from, range.to, range.mode],
  );

  const masters = useApi<ExpenseMasters>(() => api.get<ExpenseMasters>('/api/masters'), []);
  const create = useApiAction(expenseApi.create);

  const options = useMemo(() => {
    const m = masters.data;
    return {
      expenseAccounts: (m?.accounts ?? [])
        .filter((a) => a.type === 'expense')
        .map((a) => ({ value: a.id, label: a.name, sublabel: a.code })),
      banks: (m?.bankAccounts ?? []).map((b) => ({ value: b.id, label: b.name, sublabel: b.kind })),
      vendors: (m?.contacts ?? [])
        .filter((c) => c.kind === 'vendor' || c.kind === 'both')
        .map((c) => ({ value: c.id, label: c.displayName })),
    };
  }, [masters.data]);

  const save = async () => {
    if (!f.accountId || f.amount <= 0 || !f.paidThroughId) {
      toast.error('Pick a category, an account it was paid from, and an amount.');
      return;
    }

    const created = await create.run({
      branchId: session.user.branchId ?? session.branches[0]?.id,
      date: today(),
      accountId: f.accountId,
      paidThroughBankAccountId: f.paidThroughId,
      // What was entered is what was actually paid; the server extracts the GST
      // inside it rather than adding tax on top.
      amountPaise: f.amount,
      gstRatePct: f.gst,
      vendorId: f.vendorId || undefined,
      itcEligibility: f.itcEligibility,
      isBillable: f.billable,
      reference: f.reference || undefined,
      notes: f.notes || undefined,
      costCentreId: costCentreId || undefined,
    });

    if (!created) {
      if (create.wasQueued()) { setOpen(false); setF(BLANK); return; }
      toast.error(create.error ?? 'Could not record the expense.');
      return;
    }

    toastWarnings(created);
    toast.success(`Expense ${created.number} recorded`, {
      description:
        f.itcEligibility === 'eligible' && f.gst > 0
          ? 'Posted with the input credit claimed.'
          : 'Posted with the tax folded into the cost.',
    });
    setOpen(false);
    setF({ ...BLANK, paidThroughId: f.paidThroughId });
    await state.refetch();
  };

  const columns: Column<ExpenseListItem>[] = [
    { key: 'number', header: 'Expense #', sortValue: (r) => r.number, cell: (r) => <span className="font-medium">{r.number}</span> },
    {
      key: 'date',
      header: 'Date',
      sortValue: (r) => r.date,
      cell: (r) => new Date(r.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }),
    },
    {
      key: 'category',
      header: 'Category',
      sortValue: (r) => r.accountName,
      cell: (r) => (
        <span>
          <span className="font-mono text-xs text-muted-foreground">{r.accountCode}</span> {r.accountName}
        </span>
      ),
    },
    {
      key: 'notes',
      header: 'Description',
      sortValue: (r) => r.notes ?? '',
      cell: (r) => <span className="text-sm text-muted-foreground">{r.notes ?? '—'}</span>,
    },
    { key: 'paid', header: 'Paid through', sortValue: (r) => r.paidThrough, cell: (r) => r.paidThrough },
    {
      key: 'itc',
      header: 'Input credit',
      sortValue: (r) => r.itcEligibility,
      cell: (r) =>
        r.taxPaise > 0 ? (
          <Badge
            variant="outline"
            className={`text-[10px] ${r.itcEligibility === 'ineligible' ? 'border-amber-500/40 text-amber-600 dark:text-amber-400' : ''}`}
          >
            {r.itcEligibility === 'eligible' ? 'Claimed' : r.itcEligibility === 'ineligible' ? 'In cost' : 'Capital'}
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">No GST</span>
        ),
    },
    { key: 'total', header: 'Total paid', align: 'right', sortValue: (r) => r.totalPaise, cell: (r) => <Money value={r.totalPaise} /> },
  ];

  return (
    <>
      <PageHeader
        title="Expenses"
        description="Money already spent, with no supplier bill to settle later — it posts and closes in one step."
        actions={
          <>
            <Refreshing active={state.refreshing} />
            {canCreate && (
              <Dialog open={open} onOpenChange={setOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" className="gap-1.5"><Plus className="size-4" /> New expense</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader><DialogTitle>Record expense</DialogTitle></DialogHeader>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Category" required className="sm:col-span-2">
                      <Combobox
                        options={options.expenseAccounts}
                        value={f.accountId}
                        onChange={(v) => setF({ ...f, accountId: v })}
                        placeholder="Select expense account"
                        searchPlaceholder="Search accounts by name or code"
                        showAvatar={false}
                      />
                    </Field>
                    <Field label="Amount paid" required hint="Including GST — the tax is extracted from it">
                      <MoneyInput valuePaise={f.amount} onChangePaise={(p) => setF({ ...f, amount: p })} />
                    </Field>
                    <Field label="GST rate">
                      <Combobox
                        options={GST_RATES.map((r) => ({ value: String(r), label: `${r}%` }))}
                        value={String(f.gst)}
                        onChange={(v) => setF({ ...f, gst: Number(v) })}
                        showAvatar={false}
                        searchPlaceholder="Rate"
                      />
                    </Field>
                    <CostCentrePicker value={costCentreId} onChange={setCostCentreId} />
                    <Field label="Paid through" required>
                      <Combobox
                        options={options.banks}
                        value={f.paidThroughId}
                        onChange={(v) => setF({ ...f, paidThroughId: v })}
                        placeholder="Select account"
                        searchPlaceholder="Search accounts"
                        showAvatar={false}
                      />
                    </Field>
                    <Field label="Vendor" hint="Optional">
                      <ContactPicker
                        kind="vendor"
                        value={f.vendorId}
                        onChange={(v) => setF({ ...f, vendorId: v })}
                        placeholder="None"
                        canCreate={canCreate}
                      />
                    </Field>
                    <Field
                      label="Input credit"
                      className="sm:col-span-2"
                      hint="Credit on some things is blocked outright, and then the tax is part of the cost"
                    >
                      <Combobox
                        options={[
                          { value: 'eligible', label: 'Claimable' },
                          { value: 'ineligible', label: 'Blocked — Section 17(5)' },
                          { value: 'capital_goods', label: 'Capital goods' },
                        ]}
                        value={f.itcEligibility}
                        onChange={(v) => setF({ ...f, itcEligibility: v as typeof f.itcEligibility })}
                        showAvatar={false}
                      />
                    </Field>
                    <Field label="Description" className="sm:col-span-2">
                      <Input
                        value={f.notes}
                        onChange={(e) => setF({ ...f, notes: e.target.value })}
                        placeholder="What the expense was for"
                      />
                    </Field>
                    <div className="flex items-center justify-between gap-3 rounded-md border p-3 sm:col-span-2">
                      <div>
                        <p className="text-sm font-medium">Billable to a customer</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Re-charged on their next invoice.
                        </p>
                      </div>
                      <Switch checked={f.billable} onCheckedChange={(v) => setF({ ...f, billable: v })} />
                    </div>
                  </div>
                  {create.error && <p className="text-sm text-destructive">{create.error}</p>}
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                    <Button onClick={save} disabled={create.busy}>
                      {create.busy ? 'Recording…' : 'Record expense'}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            )}
          </>
        }
      />

      <AsyncPage state={state} loading={<LoadingRows rows={6} />}>
        {(data) =>
          data.summary.count === 0 && range.mode === 'all' ? (
            <EmptyState
              icon={Receipt}
              title="No expenses yet"
              description="Record what you have already paid for — fuel, rent, utilities."
            />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Card className="p-4">
                  <p className="text-xs text-muted-foreground">Expenses</p>
                  <p className="mt-1.5 tabular text-2xl font-semibold">{data.summary.count}</p>
                </Card>
                <Card className="flex items-start justify-between gap-3 p-4">
                  <div>
                    <p className="text-xs text-muted-foreground">Total paid</p>
                    <p className="mt-1.5 tabular text-2xl font-semibold">
                      {formatINRCompact(data.summary.totalPaise)}
                    </p>
                  </div>
                  <Wallet className="size-5 text-muted-foreground" />
                </Card>
              </div>

              <DataTable
                rows={data.expenses}
                columns={columns}
                getRowId={(r) => r.id}
                initialSort={{ key: 'date', dir: 'desc' }}
                searchPlaceholder="Search description or category…"
                dateFilter={{ getDate: (r) => r.date, value: range, onChange: setRange }}
              />
            </>
          )
        }
      </AsyncPage>
    </>
  );
}
