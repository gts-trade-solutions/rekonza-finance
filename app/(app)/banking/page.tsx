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
  ArrowLeftRight, ArrowRight, Banknote, CreditCard, FileClock, FileSpreadsheet,
  Landmark, Plus, ScrollText, Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
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
import { formatINRCompact } from '@/lib/money';
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
  { href: '/banking/imports', icon: FileSpreadsheet, label: 'Import statement', hint: 'Upload a CSV from your bank' },
  { href: '/banking/rules', icon: ScrollText, label: 'Bank rules', hint: 'Auto-categorise repeating lines' },
  { href: '/banking/transfers', icon: ArrowLeftRight, label: 'Transfers', hint: 'Move money between own accounts' },
  { href: '/banking/cheques', icon: FileClock, label: 'Cheques & PDC', hint: 'In hand and post-dated' },
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

  return (
    <>
      <PageHeader
        title="Banking"
        description="Balances are what the books say, not a stored figure — every one is the sum of what has been posted to that account."
        actions={
          <>
            <Refreshing active={accounts.refreshing} />
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
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {totals.map((t) => (
                  <Card key={t.label} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="micro-label">{t.label}</p>
                        <p className="mt-1.5 tabular text-2xl font-semibold">
                          {formatINRCompact(t.value)}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {t.count} account{t.count === 1 ? '' : 's'} · {t.hint}
                        </p>
                      </div>
                      <t.icon className="size-4 shrink-0 text-muted-foreground" />
                    </div>
                  </Card>
                ))}
              </div>

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {SHORTCUTS.map((sc) => (
                  <Link key={sc.href} href={sc.href}>
                    <Card className="flex h-full items-start gap-3 p-4 transition-colors hover:border-primary/40 hover:bg-accent/40">
                      <sc.icon className="mt-0.5 size-4 shrink-0 text-primary" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{sc.label}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{sc.hint}</p>
                      </div>
                    </Card>
                  </Link>
                ))}
              </div>

              <section className="space-y-3">
                <h2 className="micro-label">Accounts</h2>
                <div className="grid gap-3 lg:grid-cols-2">
                  {data.accounts.map((a) => (
                    <Card key={a.id} className="accent-bar p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium">{a.name}</p>
                            {a.isPrimary && <Badge variant="secondary" className="text-[9px]">Primary</Badge>}
                            <Badge variant="outline" className="text-[9px] capitalize">{a.kind}</Badge>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {a.bankName ?? 'Held in house'}
                            {a.accountLast4 && ` · ••••${a.accountLast4}`}
                            {a.ifsc && ` · ${a.ifsc}`}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <Money value={a.balancePaise} className="text-lg font-semibold" />
                          <p className="mt-0.5 text-[11px] text-muted-foreground">
                            {a.kind === 'card' ? 'owed' : 'available'}
                          </p>
                        </div>
                      </div>

                      <div className="mt-3 flex items-center justify-between gap-3 border-t pt-3">
                        <span className="text-xs text-muted-foreground">
                          {a.unmatchedCount > 0
                            ? `${a.unmatchedCount} statement line${a.unmatchedCount === 1 ? '' : 's'} to reconcile`
                            : 'Nothing waiting to be reconciled'}
                        </span>
                        <Button variant="ghost" size="xs" asChild>
                          <Link href={`/banking/reconcile?account=${a.id}`}>
                            Reconcile <ArrowRight className="ml-1 size-3" />
                          </Link>
                        </Button>
                      </div>
                    </Card>
                  ))}
                </div>
              </section>

              <section className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="micro-label">Waiting to be categorised</h2>
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

              <Card className="flex items-start gap-3 border-primary/30 bg-primary/5 p-4">
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
