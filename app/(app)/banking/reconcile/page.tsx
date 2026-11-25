'use client';

// Reconciliation, as Zoho Books' banking does it: statement lines on the left,
// and on the right Zoho's panel for the line picked — Match Transactions (Best
// Matches, Possible Matches, a search, several at once) and Categorize
// Manually by Zoho's categories (components/banking/bank-line-panel.tsx).
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
import { ArrowDownLeft, ArrowUpRight, Check, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { BankLinePanel, MatchedLinePanel } from '@/components/banking/bank-line-panel';
import { StatementLineActions } from '@/components/banking/line-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage, LoadingRows, Refreshing } from '@/components/shared/async-state';
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

/** A confident match in the books (lib/bank-match-score.ts). */
interface Suggestion {
  key: string;
  type: string;
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

interface Masters {
  accounts: { id: string; code: string; name: string; type: string }[];
  bankAccounts: { id: string; name: string; kind?: string }[];
  contacts: { id: string; kind: string; displayName: string }[];
}

function ReconcileInner() {
  const params = useSearchParams();
  const [accountId, setAccountId] = useState(params.get('account') ?? '');
  const [tab, setTab] = useState<'unmatched' | 'matched'>('unmatched');
  // A line can be opened straight from a link (the banking overview's list).
  const [selectedId, setSelectedId] = useState<string | null>(params.get('line'));

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

  const selected = state.data?.transactions.find((t) => t.id === selectedId) ?? null;

  const refresh = async () => {
    setSelectedId(null);
    await state.refetch();
  };

  return (
    <>
      <PageHeader
        title="Reconcile"
        description="The statement is the bank's version of events and the ledger is ours. This is where the two are squared."
        actions={
          <>
            <Refreshing active={state.refreshing} />
            {/* Rules, invoice numbers in the narration, and payments already entered (banking.ts). */}
            <Button
              variant="outline"
              size="sm"
              disabled={!accountId || act.busy}
              title={accountId ? 'Match what can be matched without a person' : 'Choose an account first'}
              onClick={async () => {
                const r = await act.run({ action: 'auto_match', bankAccountId: accountId }) as unknown as { matched?: number } | undefined;
                if (r) toast.success(r.matched ? `${r.matched} line${r.matched === 1 ? '' : 's'} matched automatically` : 'Nothing more could be matched automatically');
                await refresh();
              }}
            >
              Auto-match
            </Button>
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
              '-mb-px border-b-2 px-3 py-2 text-[13px] transition-colors',
              tab === t ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t === 'unmatched' ? 'Uncategorized' : 'Categorized'}
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
                          // Zoho's "match found" on the row: the panel offers it under Best Matches.
                          <Badge variant="outline" className="shrink-0 gap-1 border-emerald-500/40 text-[10px] text-emerald-700 dark:text-emerald-300" data-slot="match-found">
                            <Sparkles className="size-2.5" /> {hint === 1 ? 'Match found' : `${hint} matches found`}
                          </Badge>
                        )}
                        {tab === 'matched' && (
                          <Badge variant="secondary" className="shrink-0 text-[9px]">
                            {t.matchedType === 'payment' ? 'Payment' : t.matchedType === 'multiple' ? 'Several' : t.matchedType === 'expense' ? 'Expense'
                              : t.matchedType === 'transfer' ? 'Transfer' : 'Categorized'}
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

              {/* ── What to do with it: Zoho's panel ────────────────────── */}
              <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
                {!selected ? (
                  <Card className="p-6 text-center text-sm text-muted-foreground">
                    Pick a line on the left to match or categorize it.
                  </Card>
                ) : tab === 'matched' || selected.status === 'matched' ? (
                  <MatchedLinePanel key={selected.id} lineId={selected.id} onDone={refresh} onReopen={(id) => { setTab('unmatched'); setSelectedId(id); }} />
                ) : masters.data ? (
                  <>
                    {/* The line itself: corrected (a mis-read date or amount) or deleted (imported by mistake). */}
                    <Card className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5" data-slot="line-own-actions">
                      <span className="text-xs text-muted-foreground">This statement line</span>
                      <StatementLineActions line={selected} onChanged={() => { setSelectedId(null); refresh(); }} />
                    </Card>
                    <BankLinePanel key={selected.id} lineId={selected.id} masters={masters.data} onDone={refresh} />
                  </>
                ) : (
                  <Card className="p-6"><LoadingRows rows={4} /></Card>
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
