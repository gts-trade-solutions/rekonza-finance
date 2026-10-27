'use client';

// Reconciliation: statement lines on the left, what to do with each on the right.
//
// The statement is the bank's version of events and the ledger is ours. The job
// is finding where the two disagree, which is why a line stays outside the
// books until somebody says what it was for.
//
// Two outcomes, and the difference matters:
//   * Match to a payment already recorded — posts nothing. The payment posted
//     when it was entered; posting again would double the money.
//   * Categorise to an account — posts a new entry, because the money moved and
//     no document explained it.
//
// Suggestions are offered, never applied. A wrong automatic match is invisible
// until somebody reconciles the account by hand months later.

import { Suspense, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowDownLeft, ArrowUpRight, Check, Link2, Loader2, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage, LoadingRows, Refreshing } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import { api } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { cn } from '@/lib/utils';

interface TxnRow {
  id: string;
  date: string;
  narration: string;
  reference: string | null;
  depositPaise: number;
  withdrawalPaise: number;
  status: string;
  matchedType: string | null;
  matchedId: string | null;
  bankAccountId: string;
  bankName: string;
}

interface Suggestion {
  id: string;
  number: string;
  date: string;
  amountPaise: number;
}

interface TxnResponse {
  transactions: TxnRow[];
  suggestions: Record<string, Suggestion[]>;
  summary: { count: number; unmatched: number; depositsPaise: number; withdrawalsPaise: number };
}

/** Accounts whose balance must come from documents, never a free-hand entry. */
const CONTROL_ACCOUNTS = new Set([
  '1100', // Accounts Receivable — the sum of unpaid invoices
  '2100', // Accounts Payable — the sum of unpaid bills
]);

interface Masters {
  accounts: { id: string; code: string; name: string; type: string }[];
  bankAccounts: { id: string; name: string }[];
  contacts: { id: string; kind: string; displayName: string }[];
}

function ReconcileInner() {
  const params = useSearchParams();
  const [accountId, setAccountId] = useState(params.get('account') ?? '');
  const [tab, setTab] = useState<'unmatched' | 'matched'>('unmatched');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState('');
  const [contactId, setContactId] = useState('');

  const masters = useApi<Masters>(() => api.get('/api/masters'), []);

  const state = useApi<TxnResponse>(
    () =>
      api.get('/api/banking/transactions', {
        status: tab,
        bankAccountId: accountId || undefined,
        limit: 300,
      }),
    [tab, accountId],
  );

  const act = useApiAction((input: unknown) =>
    api.post<{ id: string; journalEntryId: string | null }>('/api/banking/transactions', input),
  );

  const accountOptions = useMemo(
    () => [
      { value: '', label: 'All accounts' },
      ...(masters.data?.bankAccounts ?? []).map((b) => ({ value: b.id, label: b.name })),
    ],
    [masters.data],
  );

  const categoryOptions = useMemo(
    () =>
      (masters.data?.accounts ?? [])
        .filter((a) => ['expense', 'income', 'asset', 'liability'].includes(a.type))
        // Control accounts are excluded. Receivables and payables are the sum
        // of the invoices and bills behind them, so posting to one directly
        // makes the ageing stop agreeing with it — and the ageing is what
        // anybody actually chases. Money moving there belongs on a document.
        .filter((a) => !CONTROL_ACCOUNTS.has(a.code))
        .map((a) => ({ value: a.id, label: a.name, sublabel: `${a.code} · ${a.type}` })),
    [masters.data],
  );

  const contactOptions = useMemo(
    () => (masters.data?.contacts ?? []).map((c) => ({ value: c.id, label: c.displayName })),
    [masters.data],
  );

  const selected = state.data?.transactions.find((t) => t.id === selectedId) ?? null;
  const suggestions = selectedId ? (state.data?.suggestions[selectedId] ?? []) : [];

  const refresh = async () => {
    setSelectedId(null);
    setCategoryId('');
    setContactId('');
    await state.refetch();
  };

  const matchToPayment = async (paymentId: string, number: string) => {
    if (!selected) return;
    const ok = await act.run({ action: 'match', transactionId: selected.id, paymentId });
    if (!ok) return toast.error(act.error ?? 'Could not match that line.');
    toast.success(`Matched to ${number}`, {
      description: 'Nothing new was posted — that payment was already in the books.',
    });
    await refresh();
  };

  const categorise = async () => {
    if (!selected || !categoryId) return;
    const ok = await act.run({
      action: 'categorise',
      transactionId: selected.id,
      accountId: categoryId,
      contactId: contactId || undefined,
    });
    if (!ok) return toast.error(act.error ?? 'Could not categorise that line.');
    toast.success('Line categorised', { description: 'A balanced entry has been posted.' });
    await refresh();
  };

  const unmatch = async (txnId: string) => {
    const ok = await act.run({ action: 'unmatch', transactionId: txnId });
    if (!ok) return toast.error(act.error ?? 'Could not unmatch that line.');
    toast.info('Line unmatched', {
      description: 'Any entry it posted has been reversed, not deleted.',
    });
    await refresh();
  };

  return (
    <>
      <PageHeader
        title="Reconcile"
        description="The statement is the bank's version of events and the ledger is ours. This is where the two are squared."
        actions={
          <>
            <Refreshing active={state.refreshing} />
            <div className="w-56">
              <Combobox
                options={accountOptions}
                value={accountId}
                onChange={setAccountId}
                showAvatar={false}
                searchPlaceholder="Search accounts"
              />
            </div>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-1 border-b">
        {(['unmatched', 'matched'] as const).map((t) => (
          <button
            key={t}
            type="button"
            data-slot="reconcile-tab"
            data-tab={t}
            onClick={() => { setTab(t); setSelectedId(null); }}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-[13px] capitalize transition-colors',
              tab === t ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t}
            {t === 'unmatched' && state.data ? (
              <span className="ml-1.5 tabular text-xs text-muted-foreground">
                {state.data.summary.unmatched}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
        {(data) =>
          data.transactions.length === 0 ? (
            <EmptyState
              icon={Check}
              title={tab === 'unmatched' ? 'Nothing left to reconcile' : 'Nothing matched yet'}
              description={
                tab === 'unmatched'
                  ? 'Every statement line has been accounted for.'
                  : 'Matched lines will appear here once you start reconciling.'
              }
            />
          ) : (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              {/* ── Statement lines ─────────────────────────────────────── */}
              <Card className="overflow-hidden p-0">
                <div className="divide-y">
                  {data.transactions.map((t) => {
                    const isDeposit = t.depositPaise > 0;
                    const isSelected = t.id === selectedId;
                    const hint = data.suggestions[t.id]?.length ?? 0;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        data-slot="bank-line"
                        onClick={() => setSelectedId(isSelected ? null : t.id)}
                        className={cn(
                          'flex w-full items-center gap-3 p-3.5 text-left transition-colors',
                          isSelected ? 'bg-accent' : 'hover:bg-accent/40',
                        )}
                      >
                        <span
                          className={cn(
                            'grid size-7 shrink-0 place-items-center rounded-full',
                            isDeposit
                              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                              : 'bg-muted text-muted-foreground',
                          )}
                        >
                          {isDeposit ? <ArrowDownLeft className="size-3.5" /> : <ArrowUpRight className="size-3.5" />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">{t.narration}</p>
                          <p className="text-xs text-muted-foreground">
                            {new Date(t.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })}
                            {' · '}{t.bankName}
                            {t.reference && ` · ${t.reference}`}
                          </p>
                        </div>
                        {hint > 0 && tab === 'unmatched' && (
                          <Badge variant="outline" className="shrink-0 gap-1 text-[9px]">
                            <Link2 className="size-2.5" /> {hint} match{hint === 1 ? '' : 'es'}
                          </Badge>
                        )}
                        {tab === 'matched' && (
                          <Badge variant="secondary" className="shrink-0 text-[9px]">
                            {t.matchedType === 'payment' ? 'Payment' : 'Categorised'}
                          </Badge>
                        )}
                        <Money
                          value={t.depositPaise || t.withdrawalPaise}
                          className={cn('shrink-0 font-medium', isDeposit && 'text-emerald-600 dark:text-emerald-400')}
                        />
                      </button>
                    );
                  })}
                </div>
              </Card>

              {/* ── What to do with it ──────────────────────────────────── */}
              <div className="space-y-4">
                {!selected ? (
                  <Card className="p-6 text-center text-sm text-muted-foreground">
                    Pick a line on the left to match or categorise it.
                  </Card>
                ) : tab === 'matched' ? (
                  <Card className="space-y-3 p-5">
                    <p className="text-sm font-medium">{selected.narration}</p>
                    <p className="text-xs text-muted-foreground">
                      {selected.matchedType === 'payment'
                        ? 'Matched to a payment already in the books. Nothing was posted for the match itself.'
                        : 'Categorised, which posted a journal entry.'}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={act.busy}
                      onClick={() => unmatch(selected.id)}
                      className="gap-1.5"
                    >
                      {act.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Undo2 className="size-3.5" />}
                      Unmatch
                    </Button>
                  </Card>
                ) : (
                  <>
                    <Card className="p-5">
                      <p className="micro-label">Selected line</p>
                      <p className="mt-1 text-sm font-medium">{selected.narration}</p>
                      <div className="mt-2 flex items-baseline gap-2">
                        <Money
                          value={selected.depositPaise || selected.withdrawalPaise}
                          className="text-lg font-semibold"
                        />
                        <span className="text-xs text-muted-foreground">
                          {selected.depositPaise ? 'received' : 'paid out'} on{' '}
                          {new Date(selected.date).toLocaleDateString('en-IN', {
                            day: 'numeric', month: 'short', year: 'numeric',
                          })}
                        </span>
                      </div>
                    </Card>

                    {suggestions.length > 0 && (
                      <Card className="p-5">
                        <p className="micro-label">Already in the books</p>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          Same amount, same account, within a week. Matching one of these posts nothing —
                          the payment posted when it was recorded.
                        </p>
                        <div className="mt-3 space-y-2">
                          {suggestions.map((sg) => (
                            <div
                              key={sg.id}
                              className="flex items-center gap-3 rounded-[3px] border p-2.5"
                            >
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium">{sg.number}</p>
                                <p className="text-xs text-muted-foreground">
                                  {new Date(sg.date).toLocaleDateString('en-IN', {
                                    day: 'numeric', month: 'short', year: 'numeric',
                                  })}
                                </p>
                              </div>
                              <Money value={sg.amountPaise} className="text-sm" />
                              <Button
                                size="xs"
                                disabled={act.busy}
                                onClick={() => matchToPayment(sg.id, sg.number)}
                              >
                                Match
                              </Button>
                            </div>
                          ))}
                        </div>
                      </Card>
                    )}

                    <Card className="space-y-4 p-5">
                      <div>
                        <p className="micro-label">Or categorise it</p>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          For money that moved with no document behind it — a bank charge, a direct debit.
                          This posts a new entry.
                        </p>
                      </div>
                      <Field label="Account" required>
                        <Combobox
                          options={categoryOptions}
                          value={categoryId}
                          onChange={setCategoryId}
                          placeholder="Select an account"
                          searchPlaceholder="Search by name or code"
                          showAvatar={false}
                        />
                      </Field>
                      <Field label="Contact" hint="Optional — links the entry to a customer or vendor">
                        <Combobox
                          options={contactOptions}
                          value={contactId}
                          onChange={setContactId}
                          placeholder="None"
                          searchPlaceholder="Search contacts"
                          clearable
                        />
                      </Field>
                      {act.error && <p className="text-sm text-destructive">{act.error}</p>}
                      <Button
                        onClick={categorise}
                        disabled={!categoryId || act.busy}
                        className="w-full gap-1.5"
                      >
                        {act.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                        Categorise and post
                      </Button>
                    </Card>
                  </>
                )}
              </div>
            </div>
          )
        }
      </AsyncPage>
    </>
  );
}

export default function ReconcilePage() {
  return (
    <Suspense fallback={<LoadingRows rows={8} />}>
      <ReconcileInner />
    </Suspense>
  );
}
