'use client';

// Banking overview, from the database.
//
// Balances come from what has actually been posted to each account's ledger
// account, not from a stored figure on the bank account row. A cached balance
// is a second copy of the truth, and the moment one entry is reversed the two
// disagree with nothing to say which is right.
//
// Automatic feeds are absent on purpose: pulling transactions from an Indian
// bank means an Account Aggregator, and registering as a Financial Information
// User requires being regulated by the RBI, SEBI, IRDAI or PFRDA — which
// accounting software is not. Statement import is the honest route.

import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  ArrowLeftRight, ArrowRight, Banknote, ChevronDown, CreditCard, FileClock, FileSpreadsheet,
  Landmark, ListChecks, Plus, ScrollText, Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useForceNavCollapsed } from '@/components/layout/nav-state';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage, LoadingRows, Refreshing } from '@/components/shared/async-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { usePermission } from '@/lib/store/hooks';
import { today } from '@/lib/selectors';
import { formatINR } from '@/lib/money';
import { api } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';

interface BankAccountRow {
  id: string;
  kind: string;
  name: string;
  bankName: string | null;
  accountLast4: string | null;
  ifsc: string | null;
  isPrimary: boolean;
  feedConnected: boolean;
  balancePaise: number;
  unmatchedCount: number;
}

interface TxnRow {
  id: string;
  date: string;
  narration: string;
  reference: string | null;
  depositPaise: number;
  withdrawalPaise: number;
  status: string;
  bankAccountId: string;
  bankName: string;
}

const TILES: { kinds: string[]; label: string; icon: typeof Landmark; hint: string }[] = [
  { kinds: ['bank'], label: 'Bank balance', icon: Landmark, hint: 'Current accounts' },
  { kinds: ['card'], label: 'Card balance', icon: CreditCard, hint: 'Owed on cards' },
  { kinds: ['cash', 'wallet'], label: 'Cash in hand', icon: Wallet, hint: 'Petty cash and wallets' },
  { kinds: ['clearing'], label: 'Payment clearing', icon: Banknote, hint: 'Collected, not yet banked' },
];

const SHORTCUTS = [
  { href: '/banking/imports', icon: FileSpreadsheet, label: 'Import statements', hint: 'Upload one or many: CSV, Excel, OFX, QIF, CAMT, MT940, JSON' },
  { href: '/banking/statement-lines', icon: ListChecks, label: 'Statement lines', hint: 'Categorise, exclude or delete many lines at once, with suggestions' },
  { href: '/banking/rules', icon: ScrollText, label: 'Bank rules', hint: 'Auto-categorise repeating lines' },
  { href: '/banking/transfers', icon: ArrowLeftRight, label: 'Transfers (contra)', hint: 'Move money between own accounts: cash deposited, withdrawn, bank to bank' },
  { href: '/banking/cheques', icon: FileClock, label: 'Cheques & PDC', hint: 'In hand and post-dated' },
  { href: '/reports/bank-statement', icon: ScrollText, label: 'Bank statement as on date', hint: 'Books to bank on any day: cheques not presented, deposits not credited' },
];

const BLANK = {
  kind: 'bank' as 'bank' | 'card' | 'cash' | 'wallet',
  name: '',
  bankName: '',
  accountLast4: '',
  ifsc: '',
  openingBalance: 0,
};

export default function BankingPage() {
  const canCreate = usePermission('banking', 'create');
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(BLANK);

  const accounts = useApi<{ accounts: BankAccountRow[] }>(
    () => api.get('/api/banking/accounts'),
    [],
  );
  const unmatched = useApi<{ transactions: TxnRow[]; summary: { unmatched: number } }>(
    () => api.get('/api/banking/transactions', { status: 'unmatched', limit: 8 }),
    [],
  );

  const create = useApiAction((input: unknown) =>
    api.post<{ id: string }>('/api/banking/accounts', input),
  );

  const totals = useMemo(() => {
    const rows = accounts.data?.accounts ?? [];
    return TILES.map((t) => ({
      ...t,
      value: rows.filter((a) => t.kinds.includes(a.kind)).reduce((sum, a) => sum + a.balancePaise, 0),
      count: rows.filter((a) => t.kinds.includes(a.kind)).length,
    }));
  }, [accounts.data]);

  const save = async () => {
    if (!f.name.trim()) {
      toast.error('Give the account a name.');
      return;
    }
    const created = await create.run({
      kind: f.kind,
      name: f.name.trim(),
      bankName: f.bankName || undefined,
      accountLast4: f.accountLast4 || undefined,
      ifsc: f.ifsc || undefined,
      openingBalancePaise: f.openingBalance || undefined,
      openingDate: f.openingBalance ? today() : undefined,
    });
    if (!created) {
      toast.error(create.error ?? 'Could not add the account.');
      return;
    }
    toast.success(`${f.name} added`, {
      description: 'A matching ledger account was created, so the books can see it.',
    });
    setOpen(false);
    setF(BLANK);
    await accounts.refetch();
  };

  // Zoho folds the sidebar to its rail on the Banking Overview.
  useForceNavCollapsed(true);

  return (
    <>
      <PageHeader
        title="Banking Overview"
        description="Balances are what the books say, not a stored figure — every one is the sum of what has been posted to that account."
        actions={
          <>
            <Refreshing active={accounts.refreshing} />
            <Button variant="outline" size="sm" asChild><Link href="/banking/imports">Import Statement</Link></Button>
            <Button variant="outline" size="sm" asChild><Link href="/banking/rules">Manage Transaction Rules</Link></Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1" data-slot="banking-more">
                  More <ChevronDown className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-80">
                {SHORTCUTS.map((sc) => (
                  <DropdownMenuItem key={sc.href} asChild>
                    <Link href={sc.href} className="items-start gap-2.5 py-2">
                      <sc.icon className="mt-0.5 size-4 shrink-0" />
                      <span className="min-w-0">
                        <span className="block">{sc.label}</span>
                        <span className="block text-[11px] opacity-75">{sc.hint}</span>
                      </span>
                    </Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {canCreate && (
              <Dialog open={open} onOpenChange={setOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" className="gap-1.5">
                    <Plus className="size-4" /> Add bank or credit card
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-lg">
                  <DialogHeader>
                    <DialogTitle>Add an account</DialogTitle>
                    <DialogDescription>
                      A matching ledger account is created alongside it. The two are always a pair — an
                      account the books cannot see is money nobody can reconcile.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Type" required>
                      <Combobox
                        options={[
                          { value: 'bank', label: 'Bank account' },
                          { value: 'card', label: 'Credit card' },
                          { value: 'cash', label: 'Cash in hand' },
                          { value: 'wallet', label: 'Wallet' },
                        ]}
                        value={f.kind}
                        onChange={(v) => setF({ ...f, kind: v as typeof f.kind })}
                        showAvatar={false}
                      />
                    </Field>
                    <Field label="Name" required>
                      <Input
                        value={f.name}
                        onChange={(e) => setF({ ...f, name: e.target.value })}
                        placeholder="Account name"
                      />
                    </Field>
                    {f.kind !== 'cash' && (
                      <>
                        <Field label="Bank">
                          <Input
                            value={f.bankName}
                            onChange={(e) => setF({ ...f, bankName: e.target.value })}
                            placeholder="Bank name"
                          />
                        </Field>
                        <Field label="Last 4 digits">
                          <Input
                            value={f.accountLast4}
                            onChange={(e) =>
                              setF({ ...f, accountLast4: e.target.value.replace(/\D/g, '').slice(0, 4) })
                            }
                            placeholder="0000"
                            inputMode="numeric"
                          />
                        </Field>
                      </>
                    )}
                    {f.kind === 'bank' && (
                      <Field label="IFSC" className="sm:col-span-2">
                        <Input
                          value={f.ifsc}
                          onChange={(e) => setF({ ...f, ifsc: e.target.value.toUpperCase().slice(0, 11) })}
                          placeholder="AAAA0000000"
                          className="font-mono"
                        />
                      </Field>
                    )}
                    <Field
                      label="Opening balance"
                      className="sm:col-span-2"
                      hint="Posted against Opening Balance Equity — it was earned before the books began, so it is not income"
                    >
                      <MoneyInput
                        valuePaise={f.openingBalance}
                        onChangePaise={(p) => setF({ ...f, openingBalance: p })}
                      />
                    </Field>
                  </div>
                  {create.error && <p className="text-sm text-destructive">{create.error}</p>}
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                    <Button onClick={save} disabled={create.busy}>
                      {create.busy ? 'Adding…' : 'Add account'}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            )}
          </>
        }
      />

      <AsyncPage state={accounts} loading={<LoadingRows rows={5} />}>
        {(data) =>
          data.accounts.length === 0 ? (
            <EmptyState
              icon={Landmark}
              title="No accounts yet"
              description="Add the bank accounts and cards the business actually uses."
            />
          ) : (
            <>
              {/* Zoho's overview box: the four balances with their icons, and how
                  many statement lines still wait to be categorised. */}
              <Card className="gap-0 py-0" data-slot="banking-overview">
                <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
                  <h2 className="text-[18px] font-medium">All Accounts</h2>
                  <span className="text-[13px] text-muted-foreground">{data.accounts.length} account{data.accounts.length === 1 ? '' : 's'}</span>
                </div>
                <div className="flex flex-wrap items-center gap-x-10 gap-y-4 px-5 py-5">
                  {totals.map((t, i) => (
                    <div key={t.label} className="flex items-center gap-3" data-slot="banking-total" title={`${t.count} account${t.count === 1 ? '' : 's'} · ${t.hint}`}>
                      <span className={`grid size-11 shrink-0 place-items-center rounded-lg ${['bg-[#d9f4e8] text-[#13865a]', 'bg-[#eee6fa] text-[#713dbf]', 'bg-[#eeeef3] text-[#4c526c]', 'bg-[#e1ebfc] text-[#1c5bd9]'][i % 4]}`}>
                        <t.icon className="size-5" strokeWidth={1.6} />
                      </span>
                      <span>
                        <span className="block text-[13px]">{t.label}</span>
                        <span className="block text-[15px] font-medium tabular">{formatINR(t.value)}</span>
                      </span>
                    </div>
                  ))}
                  <div className="ml-auto flex items-center gap-3">
                    <span className={cn('grid h-11 min-w-11 place-items-center rounded-lg px-2 text-[20px] font-medium tabular', (unmatched.data?.summary.unmatched ?? 0) > 0 ? 'bg-[#fde3e4] text-[#d6141d]' : 'bg-[#d9f4e8] text-[#13865a]')}>
                      {unmatched.data?.summary.unmatched ?? 0}
                    </span>
                    <span>
                      <span className="block text-[14px]">Uncategorized Transactions</span>
                      <Link href="/banking/reconcile" className="text-[13px] text-link hover:underline">Categorize now ›</Link>
                    </span>
                  </div>
                </div>
              </Card>

              {/* Zoho's "Active Accounts" table. */}
              <section className="space-y-2" data-slot="banking-accounts">
                <h2 className="flex items-center gap-1.5 text-[18px] font-medium">Active Accounts</h2>
                <div className="overflow-x-auto rounded-md border thin-scroll">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="border-b bg-table-head text-left text-[11px] font-semibold uppercase text-table-head-foreground">
                        <th className="px-5 pb-2 pt-3 font-semibold">Account Details</th>
                        <th className="px-4 pb-2 pt-3 font-semibold">Type</th>
                        <th className="px-4 pb-2 pt-3 font-semibold">Uncategorized</th>
                        <th className="px-4 pb-2 pt-3 text-right font-semibold">Amount in Books</th>
                        <th className="px-5 pb-2 pt-3" />
                      </tr>
                    </thead>
                    <tbody>
                      {data.accounts.map((a) => (
                        <tr key={a.id} className="border-b last:border-0 hover:bg-row-hover" data-slot="bank-account-row">
                          <td className="px-5 py-3">
                            <span className="flex items-center gap-3">
                              <span className="grid size-8 shrink-0 place-items-center rounded-full border text-muted-foreground"><Landmark className="size-4" strokeWidth={1.6} /></span>
                              <span className="min-w-0">
                                <Link href={`/banking/reconcile?account=${a.id}`} className="font-medium text-link hover:underline">{a.name}</Link>
                                {a.isPrimary && <span className="ml-2 text-[11px] font-medium uppercase text-success">Primary</span>}
                                <span className="block text-[12px] text-muted-foreground">
                                  {a.bankName ?? 'Held in house'}
                                  {a.accountLast4 && ` · ••••${a.accountLast4}`}
                                  {a.ifsc && ` · ${a.ifsc}`}
                                </span>
                              </span>
                            </span>
                          </td>
                          <td className="px-4 py-3 capitalize">{a.kind}</td>
                          <td className="px-4 py-3">
                            {a.unmatchedCount > 0 ? (
                              <Link href={`/banking/reconcile?account=${a.id}`} className="text-[#d6141d] hover:underline">
                                {a.unmatchedCount} transaction{a.unmatchedCount === 1 ? '' : 's'}
                              </Link>
                            ) : (
                              <span className="text-muted-foreground">None</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <Money value={a.balancePaise} className="font-medium" />
                            <span className="block text-[11px] text-muted-foreground">{a.kind === 'card' ? 'owed' : 'available'}</span>
                          </td>
                          <td className="px-5 py-3 text-right">
                            <Link href={`/banking/reconcile?account=${a.id}`} className="inline-flex items-center gap-1 text-[13px] text-link hover:underline">
                              Reconcile <ArrowRight className="size-3" />
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-[16px] font-medium">Waiting to be categorised</h2>
                  <Button variant="ghost" size="sm" asChild>
                    <Link href="/banking/reconcile">
                      Reconcile all <ArrowRight className="ml-1 size-3.5" />
                    </Link>
                  </Button>
                </div>
                {(unmatched.data?.transactions ?? []).length === 0 ? (
                  <Card className="p-6 text-center text-sm text-muted-foreground">
                    Every statement line has been accounted for.
                  </Card>
                ) : (
                  <Card className="overflow-hidden p-0">
                    <div className="divide-y">
                      {(unmatched.data?.transactions ?? []).map((t) => (
                        <div key={t.id} className="flex items-center gap-4 p-3.5">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm">{t.narration}</p>
                            <p className="text-xs text-muted-foreground">
                              {new Date(t.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
                              {' · '}{t.bankName}
                            </p>
                          </div>
                          <Money
                            value={t.depositPaise || t.withdrawalPaise}
                            className={t.depositPaise ? 'text-emerald-600 dark:text-emerald-400' : ''}
                          />
                        </div>
                      ))}
                    </div>
                  </Card>
                )}
              </section>

              <Card className="flex-row items-start gap-3 bg-table-head p-4">
                <Landmark className="mt-0.5 size-4 shrink-0 text-primary" />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Automatic bank feeds need a licensed Account Aggregator, and registering as a Financial
                  Information User requires being regulated by the RBI, SEBI, IRDAI or PFRDA — which
                  accounting software is not. Importing a statement is the supported route, and re-importing
                  an overlapping one is safe: lines already present are skipped rather than doubled.
                </p>
              </Card>
            </>
          )
        }
      </AsyncPage>
    </>
  );
}
