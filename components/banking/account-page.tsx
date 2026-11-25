'use client';

// Zoho Books' bank account page (/banking/transactions?account_id=…).
//
// The header: the account (a switcher to the others, with what the books hold
// in each), its number, Quick Categorize, Add Transaction ▾, Record Deposit,
// the ⚙ menu (Edit, Import Statement, Reconcile, Manage Transaction Rules,
// Mark as Inactive, Delete) and the close. Under it "Amount in Rekonza" (and
// what the bank last said), then Zoho's tabs:
//   Dashboard — the account's summary and balance chart;
//   N Uncategorized Transactions — statement lines waiting, with View By,
//     the All / Best Matches / Recognized pills and Excluded; a line opens
//     Zoho's Match Transactions / Categorize Manually panel beneath it
//     (components/banking/bank-line-panel.tsx);
//   All Transactions (in Rekonza) ▾ — what the books hold for the account;
//   the cheques still waiting to clear.
// Multi-Select & Match ticks lines to match several to one transaction in the
// books, or to exclude them together.
//
// Zoho folds the sidebar to its rail on an account's page, and so does this.

import { InboxStrip } from '@/components/banking/inbound-statements';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownUp, ChevronDown, CreditCard, FileClock, HandCoins, Landmark, Search, Settings, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { BankLinePanel, MatchedLinePanel } from '@/components/banking/bank-line-panel';
import { StatementLineActions } from '@/components/banking/line-actions';
import { LedgerEntryActions } from '@/components/reports/ledger-entry-actions';
import { ConfirmDelete, DeleteButton, EditButton } from '@/components/shared/row-actions';
import { AddTransactionMenu, AddTransactionSheet, type AddKind } from '@/components/banking/add-transaction';
import { useForceNavCollapsed } from '@/components/layout/nav-state';
import { LoadingRows } from '@/components/shared/async-state';
import { usePermission } from '@/lib/store/hooks';
import { formatINR } from '@/lib/money';
import { api, ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { cn } from '@/lib/utils';

interface Head {
  account: {
    id: string; kind: string; name: string; code: string | null; accountNumber: string | null; accountLast4: string | null;
    bankName: string | null; isActive: boolean; isPrimary: boolean; balancePaise: number; amountInBankPaise: number | null; amountInBankOn: string | null;
  };
  others: { id: string; name: string; kind: string; accountNumber: string | null; amountInBooksPaise: number }[];
  counts: { uncategorized: number; bestMatches: number; recognized: number; excluded: number; manuallyExcluded?: number; autoExcluded?: number; chequesPending: number };
}
interface Line {
  id: string; date: string; narration: string; reference: string | null; depositPaise: number; withdrawalPaise: number;
  status: string; runningBalancePaise: number | null; excludeReason: string | null; autoExcluded?: boolean;
  recognizedBy: { ruleName: string; recordAs: string | null; accountName: string | null } | null;
}
interface Book {
  entryId: string; entryNo: number; date: string; reference: string | null; party: string | null; type: string;
  sourceType: string; sourceId: string | null; status: string; depositPaise: number; withdrawalPaise: number; runningBalancePaise: number;
  reversalOf?: { entryId: string; entryNo: number } | null; reversedBy?: { entryId: string; entryNo: number } | null;
}
interface Masters {
  accounts: { id: string; code: string; name: string; type: string }[];
  bankAccounts: { id: string; name: string; kind?: string }[];
  contacts: { id: string; kind: string; displayName: string }[];
}
interface Candidate { key: string; type: 'payment' | 'expense' | 'transfer' | 'journal'; id: string; number: string; party: string | null; date: string; amountPaise: number }

type Tab = 'dashboard' | 'uncategorized' | 'all' | 'excluded';
const TAB_OF: Record<string, Tab> = { 'Status.Uncategorized': 'uncategorized', 'Status.All': 'all', 'Status.Excluded': 'excluded', Dashboard: 'dashboard' };
const FILTER_OF: Record<Tab, string> = { uncategorized: 'Status.Uncategorized', all: 'Status.All', excluded: 'Status.Excluded', dashboard: 'Dashboard' };

const day = (iso: string) => new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const numberOf = (a: { accountNumber: string | null; accountLast4?: string | null; code?: string | null }) =>
  a.accountNumber ?? (a.accountLast4 ? `••••${a.accountLast4}` : a.code ?? '—');
const recordAsLabel = (k: string | null) => (k ? k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'Categorize');

/** Where a transaction in the books opens. */
function bookHref(b: Book): string | null {
  if (!b.sourceId) return b.sourceType === 'manual' ? '/accountant/journals' : null;
  switch (b.sourceType) {
    case 'invoice': return `/sales/invoices/${b.sourceId}`;
    case 'bill': return `/purchases/bills/${b.sourceId}`;
    case 'payment_received': return `/print/payment-received/${b.sourceId}`;
    case 'payment_made': return `/print/payment-made/${b.sourceId}`;
    case 'expense': return '/purchases/expenses';
    case 'transfer': return '/banking/transfers';
    default: return null;
  }
}

export function BankAccountPage() {
  useForceNavCollapsed(true);
  const router = useRouter();
  const params = useSearchParams();
  const canCreate = usePermission('banking', 'create');
  const canEdit = usePermission('banking', 'edit');
  const canDelete = usePermission('banking', 'void');

  // No account named: the first one there is, as Zoho opens Banking on one.
  const list = useApi<{ accounts: { id: string }[] }>(() => api.get('/api/banking/accounts'), []);
  const accountId = params.get('account_id') ?? '';
  useEffect(() => {
    if (!accountId && list.data?.accounts[0]) router.replace(`/banking/transactions?account_id=${list.data.accounts[0].id}`);
  }, [accountId, list.data, router]);

  const head = useApi<Head>(() => (accountId ? api.get(`/api/banking/accounts/${accountId}`) : Promise.resolve(null as unknown as Head)), [accountId]);
  const counts = head.data?.counts;
  const asked = TAB_OF[params.get('filter_by') ?? ''];
  const tab: Tab = asked ?? (counts ? (counts.uncategorized > 0 ? 'uncategorized' : 'all') : 'uncategorized');
  const setTab = (t: Tab) => { setOpenLine(null); setPicked(new Set()); router.replace(`/banking/transactions?account_id=${accountId}&filter_by=${FILTER_OF[t]}`); };

  const [pill, setPill] = useState<'all' | 'best' | 'recognized'>('all');
  // Excluded's pills (Zoho's): kept out by a person, or automatically as a duplicate at import.
  const [excludedPill, setExcludedPill] = useState<'manually_excluded' | 'auto_excluded'>('manually_excluded');
  const [direction, setDirection] = useState<'' | 'in' | 'out'>('');
  const [booksDirection, setBooksDirection] = useState<'' | 'in' | 'out'>('');
  const [sortAsc, setSortAsc] = useState(false);
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState('');
  const [openLine, setOpenLine] = useState<string | null>(null);
  const [multi, setMulti] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<AddKind | null>(null);
  const [depositFrom, setDepositFrom] = useState<string | undefined>(undefined);
  const [matching, setMatching] = useState(false);
  const [excluding, setExcluding] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  useEffect(() => { setPill('all'); setDirection(''); setOpenLine(null); setPicked(new Set()); }, [accountId]);

  const masters = useApi<Masters>(() => api.get('/api/masters'), []);
  const lines = useApi<{ transactions: Line[] }>(
    () => (accountId && (tab === 'uncategorized' || tab === 'excluded')
      ? api.get('/api/banking/transactions', {
          bankAccountId: accountId, status: tab === 'excluded' ? 'excluded' : 'unmatched',
          view: tab === 'uncategorized' ? (pill !== 'all' ? pill : undefined) : excludedPill, limit: 500,
        })
      : Promise.resolve({ transactions: [] })),
    [accountId, tab, pill, excludedPill],
  );
  const books = useApi<{ transactions: Book[]; closingPaise: number }>(
    () => (accountId && tab === 'all' ? api.get(`/api/banking/accounts/${accountId}/books`, { direction: booksDirection || undefined }) : Promise.resolve({ transactions: [], closingPaise: 0 })),
    [accountId, tab, booksDirection],
  );

  const refresh = useCallback(async () => {
    setOpenLine(null); setPicked(new Set());
    await Promise.all([head.refetch(), lines.refetch(), books.refetch()]);
  }, [head, lines, books]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = (lines.data?.transactions ?? [])
      .filter((l) => !direction || (direction === 'in' ? l.depositPaise > 0 : l.withdrawalPaise > 0))
      .filter((l) => !q || `${l.narration} ${l.reference ?? ''}`.toLowerCase().includes(q));
    return [...rows].sort((a, b) => (sortAsc ? 1 : -1) * (a.date.localeCompare(b.date) || Number(a.id) - Number(b.id)));
  }, [lines.data, direction, search, sortAsc]);
  const pickedLines = shown.filter((l) => picked.has(l.id));
  const pickedTotal = pickedLines.reduce((t, l) => t + (l.depositPaise || l.withdrawalPaise), 0);
  const pickedDirection = pickedLines.length && pickedLines.every((l) => l.depositPaise > 0) ? 'in'
    : pickedLines.length && pickedLines.every((l) => l.withdrawalPaise > 0) ? 'out' : null;

  const post = async (body: unknown, ok: string) => {
    setBusy(true);
    try { await api.post('/api/banking/transactions', body); toast.success(ok); await refresh(); return true; }
    catch (e) { toast.error(e instanceof ApiError ? e.message : 'That did not work.'); return false; }
    finally { setBusy(false); }
  };

  if (!accountId || head.loading && !head.data) return <LoadingRows rows={8} />;
  if (head.error || !head.data) return <p className="p-6 text-sm text-destructive">{head.error ?? 'That account could not be opened.'}</p>;
  const { account, others } = head.data;
  const c = head.data.counts;
  const Icon = account.kind === 'card' ? CreditCard : account.kind === 'cash' || account.kind === 'wallet' ? HandCoins : Landmark;
  const clearing = (masters.data?.bankAccounts ?? []).find((b) => b.kind === 'clearing' && b.id !== account.id);

  return (
    <div className="-mx-6 -mt-5 space-y-0" data-slot="bank-account-page">
      {/* Zoho's strip above the account: its own address for emailed statements. */}
      {account.kind !== 'clearing' && <InboxStrip accountId={account.id} />}
      {/* ── Title band ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start gap-3 border-b bg-surface px-5 py-3.5">
        <div className="min-w-0 flex-1">
          <DropdownMenu>
            {/* The account's name is the page's title, and Zoho's switcher to the others. */}
            <h1 className="text-[20px] font-normal leading-tight">
              <DropdownMenuTrigger className="inline-flex items-center gap-1.5 outline-none" data-slot="account-switcher">
                {account.name} <ChevronDown className="size-4 text-link" strokeWidth={2.4} />
              </DropdownMenuTrigger>
            </h1>
            <DropdownMenuContent align="start" className="w-[420px] p-0">
              <div className="border-b px-3 py-2 text-[13px] font-medium">{account.name}</div>
              <div className="grid grid-cols-[1fr_auto] gap-x-4 bg-table-head px-3 py-1.5 text-[10px] font-semibold uppercase text-table-head-foreground">
                <span>Account Details</span><span>Amount in Rekonza</span>
              </div>
              {others.map((o) => (
                <DropdownMenuItem key={o.id} onClick={() => router.push(`/banking/transactions?account_id=${o.id}`)} className="grid grid-cols-[1fr_auto] gap-x-4 rounded-none px-3 py-2" data-slot="switch-account">
                  <span className="min-w-0"><span className="block truncate">{o.name}</span><span className="block text-[11px] text-muted-foreground">{o.accountNumber ?? '—'}</span></span>
                  <span className="tabular">{formatINR(o.amountInBooksPaise)}</span>
                </DropdownMenuItem>
              ))}
              {others.length === 0 && <p className="px-3 py-3 text-[12px] text-muted-foreground">No other active account.</p>}
            </DropdownMenuContent>
          </DropdownMenu>
          <p className="text-[12px] text-muted-foreground">Account Number: {numberOf(account)}{!account.isActive && ' · Inactive'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canCreate && <Button variant="outline" size="sm" asChild data-slot="quick-categorize"><Link href={`/banking/statement-lines?account=${account.id}`}>Quick Categorize</Link></Button>}
          {canCreate && account.isActive && <AddTransactionMenu kind={account.kind} onPick={(k) => { setDepositFrom(undefined); setAdding(k); }} />}
          {canCreate && account.isActive && account.kind !== 'card' && (
            <Button variant="outline" size="sm" data-slot="record-deposit" onClick={() => { setDepositFrom(clearing?.id); setAdding('transfer_from'); }}>Record Deposit</Button>
          )}
          {/* Edit and Delete in words; the ⚙ menu keeps them too, with the rest. */}
          {canEdit && <EditButton onClick={() => router.push(`/banking/${account.id}/edit`)} title={`Edit ${account.name}`} className="h-[30px]" />}
          {canDelete && <DeleteButton onClick={() => setDeletingAccount(true)} title={`Delete ${account.name}`} className="h-[30px]" />}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon-sm" aria-label="Account settings" data-slot="account-settings"><Settings className="size-4" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {canEdit && <DropdownMenuItem onClick={() => router.push(`/banking/${account.id}/edit`)}>Edit</DropdownMenuItem>}
              <DropdownMenuItem onClick={() => router.push(`/banking/imports?account=${account.id}`)}>Import Statement</DropdownMenuItem>
              <DropdownMenuItem onClick={() => router.push(`/banking/reconcile?account=${account.id}`)}>Reconcile</DropdownMenuItem>
              <DropdownMenuItem onClick={() => router.push('/banking/rules')}>Manage Transaction Rules</DropdownMenuItem>
              {(canEdit || canDelete) && <DropdownMenuSeparator />}
              {canEdit && <DropdownMenuItem onClick={async () => {
                try { await api.patch(`/api/banking/accounts/${account.id}`, { isActive: !account.isActive }); toast.success(account.isActive ? 'Marked as inactive' : 'Marked as active'); await head.refetch(); }
                catch (e) { toast.error(e instanceof ApiError ? e.message : 'That did not work.'); }
              }}>{account.isActive ? 'Mark as Inactive' : 'Mark as Active'}</DropdownMenuItem>}
              {canDelete && <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setDeletingAccount(true)}>Delete</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
          <Link href="/banking" aria-label="Close" className="grid size-8 place-items-center text-destructive hover:opacity-80" data-slot="account-close"><X className="size-5" strokeWidth={1.6} /></Link>
        </div>
      </div>

      {/* ── Amount in Rekonza ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-8 border-b bg-surface px-5 py-4">
        <span className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-lg border text-link"><Icon className="size-5" strokeWidth={1.6} /></span>
          <span><span className="block text-[12px] text-muted-foreground">Amount in Rekonza</span><span className="block text-[16px] font-medium tabular" data-slot="amount-in-books">{formatINR(account.balancePaise)}</span></span>
        </span>
        {account.amountInBankPaise != null && (
          <span><span className="block text-[12px] text-muted-foreground">Amount in Bank{account.amountInBankOn ? ` (as of ${day(account.amountInBankOn)})` : ''}</span>
            <span className="block text-[16px] font-medium tabular">{formatINR(account.amountInBankPaise)}</span></span>
        )}
      </div>

      {/* ── Zoho's tabs ───────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-stretch gap-0 border-b bg-[#f6f6fa] px-3 pt-2" data-slot="account-tabs">
        <TabButton active={tab === 'dashboard'} onClick={() => setTab('dashboard')} title="Dashboard" sub="Account Summary" slot="dashboard" />
        <TabButton active={tab === 'uncategorized' || tab === 'excluded'} onClick={() => setTab('uncategorized')} slot="uncategorized"
          title={<><span className={c.uncategorized ? 'text-[#d6141d]' : ''}>{c.uncategorized}</span> Uncategorized Transactions</>} sub="From Bank Statements" />
        <div className={cn('flex items-stretch', tab === 'all' && 'rounded-t-md border border-b-0 bg-surface')}>
          <button type="button" onClick={() => setTab('all')} className="px-4 py-2 text-left" data-slot="account-tab" data-tab="all">
            <span className="block text-[15px]">All Transactions</span><span className="block text-[12px] text-muted-foreground">In Rekonza</span>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger aria-label="All Transactions view" className="px-2 text-muted-foreground outline-none hover:text-foreground" data-slot="books-view"><ChevronDown className="size-3.5" /></DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {([['', 'All'], ['in', 'Deposits'], ['out', 'Withdrawals']] as const).map(([v, l]) => (
                <DropdownMenuItem key={l} onClick={() => { setBooksDirection(v); setTab('all'); }}>{l}</DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Link href="/banking/cheques" className="relative mx-3 grid place-items-center px-2 text-muted-foreground hover:text-foreground" aria-label="Cheques waiting to clear" title="Cheques waiting to clear" data-slot="cheques-badge">
          <FileClock className="size-5" strokeWidth={1.5} />
          {c.chequesPending > 0 && <span className="absolute right-0 top-1 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] font-semibold leading-4 text-primary-foreground">{c.chequesPending}</span>}
        </Link>
        {(tab === 'uncategorized' || tab === 'excluded') && (
          <label className="ml-auto flex items-center gap-2 self-center pb-1 text-[13px] italic" data-slot="multi-select">
            Multi-Select &amp; Match <Switch checked={multi} onCheckedChange={(v) => { setMulti(!!v); setPicked(new Set()); }} />
          </label>
        )}
      </div>

      <div className="bg-surface">
        {tab === 'dashboard' && <AccountDashboard accountId={account.id} kind={account.kind} counts={c} />}

        {(tab === 'uncategorized' || tab === 'excluded') && (
          <>
            {/* View By, the pills and Excluded. */}
            <div className="flex flex-wrap items-center gap-3 border-b px-5 py-2.5 text-[13px]" data-slot="line-filters">
              {tab === 'uncategorized' ? (
                <>
                  <span className="text-muted-foreground">View By:</span>
                  <DropdownMenu>
                    <DropdownMenuTrigger className="inline-flex items-center gap-1 font-medium outline-none" data-slot="view-by">
                      {direction === 'in' ? 'Deposits' : direction === 'out' ? 'Withdrawals' : 'All transactions'} <ChevronDown className="size-3.5" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem onClick={() => setDirection('')}>All transactions</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setDirection('in')}>Deposits</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setDirection('out')}>Withdrawals</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <span className="h-5 w-px bg-border" />
                  <Pill active={pill === 'all'} onClick={() => setPill('all')} slot="all">All ({c.uncategorized})</Pill>
                  <Pill active={pill === 'best'} onClick={() => setPill('best')} slot="best">Best Matches ({c.bestMatches})</Pill>
                  <Pill active={pill === 'recognized'} onClick={() => setPill('recognized')} slot="recognized">Recognized ({c.recognized})</Pill>
                  <button type="button" className="ml-auto text-link hover:underline" onClick={() => setTab('excluded')} data-slot="excluded-link">Excluded</button>
                </>
              ) : (
                <>
                  <span className="text-muted-foreground">View By:</span><span className="font-medium">Excluded transactions</span>
                  <span className="h-5 w-px bg-border" />
                  <Pill active={excludedPill === 'manually_excluded'} onClick={() => { setExcludedPill('manually_excluded'); setPicked(new Set()); }} slot="manually-excluded">Manually Excluded ({c.manuallyExcluded ?? c.excluded})</Pill>
                  <Pill active={excludedPill === 'auto_excluded'} onClick={() => { setExcludedPill('auto_excluded'); setPicked(new Set()); }} slot="auto-excluded">Automatically Excluded ({c.autoExcluded ?? 0})</Pill>
                  <button type="button" className="ml-auto text-link hover:underline" onClick={() => setTab('uncategorized')}>Uncategorized</button>
                </>
              )}
            </div>

            {multi && picked.size > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-b bg-[#f6f6fa] px-5 py-2 text-[13px]" data-slot="multi-bar">
                <span>{picked.size} selected · {formatINR(pickedTotal)}</span>
                {tab === 'uncategorized' && (
                  <>
                    <Button size="sm" disabled={picked.size < 2 || !pickedDirection || busy} onClick={() => setMatching(true)} data-slot="multi-match"
                      title={pickedDirection ? 'Match the lines together to one transaction in the books' : 'Choose only deposits, or only withdrawals'}>Match</Button>
                    {pill === 'recognized' && <Button size="sm" variant="outline" disabled={busy} data-slot="multi-apply-rules"
                      onClick={() => void post({ action: 'apply_rules', transactionIds: [...picked] }, 'Categorized as their rules say')}>Categorize</Button>}
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => { setReason(''); setExcluding(true); }} data-slot="multi-exclude">Exclude</Button>
                  </>
                )}
                {tab === 'excluded' && <Button size="sm" variant="outline" disabled={busy} data-slot="multi-restore"
                  onClick={() => void post({ action: 'include', transactionIds: [...picked] }, 'Restored to Uncategorized')}>Restore</Button>}
                <button type="button" className="ml-auto text-muted-foreground hover:text-foreground" onClick={() => setPicked(new Set())}>Clear</button>
              </div>
            )}

            {lines.loading && !lines.data ? <div className="p-5"><LoadingRows rows={6} /></div> : (
              <table className="w-full text-[13px]" data-slot="line-table">
                <thead>
                  <tr className="border-b bg-table-head text-left text-[11px] font-semibold uppercase text-table-head-foreground">
                    {multi && <th className="w-10 px-4 py-2.5"><Checkbox aria-label="Select all" checked={shown.length > 0 && picked.size === shown.length}
                      onCheckedChange={(v) => setPicked(v ? new Set(shown.map((l) => l.id)) : new Set())} /></th>}
                    <th className="w-32 px-4 py-2.5 font-semibold">
                      <button type="button" className="inline-flex items-center gap-1 uppercase" onClick={() => setSortAsc((x) => !x)} data-slot="sort-date">Date <ArrowDownUp className="size-3" /></button>
                    </th>
                    <th className="px-4 py-2.5 font-semibold">Statement Details</th>
                    {tab === 'uncategorized' && pill === 'recognized' && <th className="px-4 py-2.5 font-semibold">Recognized Transactions</th>}
                    {tab === 'excluded' && <th className="px-4 py-2.5 font-semibold">Reason</th>}
                    <th className="px-4 py-2.5 text-right font-semibold">Deposits</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Withdrawals</th>
                    {tab === 'uncategorized' && pill !== 'recognized' && <th className="px-4 py-2.5 text-right font-semibold">Running Balance</th>}
                    <th className="w-[170px] px-3 py-2 text-right">
                      {searching ? (
                        <span className="inline-flex items-center gap-1"><Input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" className="h-7 w-36 text-[12px] normal-case" data-slot="line-search" />
                          <button type="button" aria-label="Close search" onClick={() => { setSearching(false); setSearch(''); }}><X className="size-3.5" /></button></span>
                      ) : <button type="button" aria-label="Search lines" onClick={() => setSearching(true)} className="text-muted-foreground hover:text-foreground"><Search className="size-3.5" /></button>}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((l) => {
                    const open = openLine === l.id;
                    const cols = 5 + (multi ? 1 : 0) + (tab === 'excluded' || pill === 'recognized' ? 1 : 0);
                    return (
                      <Fragment key={l.id}>
                        <tr className={cn('cursor-pointer border-b hover:bg-row-hover', open && 'bg-row-hover')} data-slot="bank-line" data-line={l.id}
                          onClick={() => { if (!multi && tab === 'uncategorized') setOpenLine(open ? null : l.id); }}>
                          {multi && <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                            <Checkbox aria-label={`Select ${l.narration}`} checked={picked.has(l.id)} onCheckedChange={(v) => setPicked((p) => { const n = new Set(p); if (v) n.add(l.id); else n.delete(l.id); return n; })} />
                          </td>}
                          <td className="px-4 py-3 whitespace-nowrap">{day(l.date)}</td>
                          <td className="px-4 py-3"><span className="block">{l.narration}</span>{l.reference && <span className="block text-[11px] text-muted-foreground">Ref# {l.reference}</span>}</td>
                          {tab === 'uncategorized' && pill === 'recognized' && (
                            <td className="px-4 py-3" data-slot="recognized-as">
                              {l.recognizedBy ? <><span className="block">{recordAsLabel(l.recognizedBy.recordAs)}{l.recognizedBy.accountName ? ` · ${l.recognizedBy.accountName}` : ''}</span>
                                <span className="block text-[11px] text-muted-foreground">Rule: {l.recognizedBy.ruleName}</span></> : '—'}
                            </td>
                          )}
                          {tab === 'excluded' && <td className="px-4 py-3 text-muted-foreground" data-slot="exclude-reason">{l.excludeReason ?? 'Excluded manually'}</td>}
                          <td className="px-4 py-3 text-right tabular">{l.depositPaise ? formatINR(l.depositPaise) : ''}</td>
                          <td className="px-4 py-3 text-right tabular">{l.withdrawalPaise ? formatINR(l.withdrawalPaise) : ''}</td>
                          {tab === 'uncategorized' && pill !== 'recognized' && <td className="px-4 py-3 text-right tabular text-muted-foreground">{l.runningBalancePaise == null ? '' : formatINR(l.runningBalancePaise)}</td>}
                          <td className="px-3 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                            {tab === 'excluded' && canEdit && <button type="button" className="text-link hover:underline" data-slot="restore-line"
                              onClick={() => void post({ action: 'include', transactionIds: [l.id] }, 'Restored to Uncategorized')}>Restore</button>}
                            {tab === 'uncategorized' && pill === 'recognized' && canCreate && l.recognizedBy && <button type="button" className="text-link hover:underline" data-slot="apply-rule"
                              onClick={() => void post({ action: 'apply_rules', transactionIds: [l.id] }, 'Categorized as the rule says')}>Categorize</button>}
                            <StatementLineActions className="mt-1" line={l} onChanged={() => void refresh()} onReopen={(id) => setOpenLine(id)} />
                          </td>
                        </tr>
                        {open && (
                          <tr className="border-b bg-[#fafafc]" data-slot="line-panel-row">
                            <td colSpan={cols + 1} className="px-5 py-4">
                              <div className="max-w-[760px]">
                                {l.status === 'matched' ? <MatchedLinePanel lineId={l.id} onDone={refresh} />
                                  : masters.data ? <BankLinePanel key={l.id} lineId={l.id} masters={masters.data} onDone={refresh} />
                                    : <LoadingRows rows={3} />}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                  {shown.length === 0 && (
                    <tr><td colSpan={8} className="px-5 py-16 text-center text-[14px] text-muted-foreground" data-slot="lines-empty">
                      {tab === 'excluded' ? 'There are no excluded transactions.'
                        : pill === 'recognized' ? (
                          <span className="block text-left sm:mx-auto sm:max-w-xl">There are no Recognized transactions due to one of the following reasons:<br />
                            1. Transaction Rules have not yet been created. Transactions are recognized based on the rule criteria.<br />
                            2. The transactions in your bank do not satisfy the criteria in any of your transaction rule(s).</span>
                        ) : pill === 'best' ? 'There are no transactions with best matches.' : 'There are no uncategorized transactions.'}
                    </td></tr>
                  )}
                </tbody>
              </table>
            )}
          </>
        )}

        {tab === 'all' && (
          books.loading && !books.data ? <div className="p-5"><LoadingRows rows={6} /></div> : (
            <table className="w-full text-[13px]" data-slot="books-table">
              <thead>
                <tr className="border-b bg-table-head text-left text-[11px] font-semibold uppercase text-table-head-foreground">
                  <th className="w-32 px-4 py-2.5 font-semibold">Date</th>
                  <th className="px-4 py-2.5 font-semibold">Reference#</th>
                  <th className="px-4 py-2.5 font-semibold">Type</th>
                  <th className="px-4 py-2.5 font-semibold">Status</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Deposits</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Withdrawals</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Running Balance</th>
                  <th className="sticky right-0 w-[176px] bg-table-head px-2 py-2.5 text-right font-semibold" data-slot="books-actions-head">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(books.data?.transactions ?? []).map((b) => {
                  const href = bookHref(b);
                  return (
                    <tr key={`${b.entryId}-${b.date}-${b.depositPaise}-${b.withdrawalPaise}`} className="border-b hover:bg-row-hover" data-slot="book-row">
                      <td className="px-4 py-3 whitespace-nowrap">{day(b.date)}</td>
                      <td className="px-4 py-3">{href ? <Link href={href} className="text-link hover:underline">{b.reference || `#${b.entryNo}`}</Link> : (b.reference || `#${b.entryNo}`)}
                        {b.party && <span className="block text-[11px] text-muted-foreground">{b.party}</span>}</td>
                      <td className="px-4 py-3">{b.type}</td>
                      <td className={cn('px-4 py-3 text-[12px] font-medium uppercase', b.status === 'Matched' ? 'text-success' : b.status === 'Categorized' ? 'text-link' : 'text-muted-foreground')}>{b.status}</td>
                      <td className="px-4 py-3 text-right tabular">{b.depositPaise ? formatINR(b.depositPaise) : ''}</td>
                      <td className="px-4 py-3 text-right tabular">{b.withdrawalPaise ? formatINR(b.withdrawalPaise) : ''}</td>
                      <td className="px-4 py-3 text-right tabular">{formatINR(b.runningBalancePaise)}</td>
                      <td className="sticky right-0 bg-card px-2 py-1 text-right shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.12)]">
                        <LedgerEntryActions row={{ entryId: b.entryId, entryNo: b.entryNo, sourceType: b.sourceType, sourceId: b.sourceId, reversalOf: b.reversalOf ?? null, reversedBy: b.reversedBy ?? null }}
                          onChanged={() => void refresh()} />
                      </td>
                    </tr>
                  );
                })}
                {(books.data?.transactions ?? []).length === 0 && (
                  <tr><td colSpan={8} className="px-5 py-16 text-center text-[14px] text-muted-foreground" data-slot="books-empty">
                    There are no transactions recorded for this account. Begin by adding new transactions or simply import your latest account statement.
                  </td></tr>
                )}
              </tbody>
            </table>
          )
        )}
      </div>

      <ConfirmDelete
        open={deletingAccount}
        onClose={() => setDeletingAccount(false)}
        title={`Delete ${account.name}?`}
        description="Only an account nothing has been posted to, and with no statement lines, can be deleted. One with transactions is kept for its history: mark it as inactive instead."
        withReasonField={false}
        onConfirm={async () => { await api.delete(`/api/banking/accounts/${account.id}`); router.push('/banking'); }}
        done={`${account.name} deleted`}
        alternative={account.isActive && canEdit ? {
          label: 'Mark as inactive',
          note: 'Inactive: it leaves the lists and pickers; its history stays.',
          run: async () => { await api.patch(`/api/banking/accounts/${account.id}`, { isActive: false }); await head.refetch(); },
          done: `${account.name} marked as inactive`,
        } : undefined}
      />

      <AddTransactionSheet kind={adding} account={account} preset={{ otherBankAccountId: depositFrom }}
        onClose={() => setAdding(null)} onDone={() => { setAdding(null); void refresh(); }} />

      <MatchTogetherDialog open={matching} onClose={() => setMatching(false)} accountId={account.id} direction={pickedDirection ?? 'in'}
        totalPaise={pickedTotal} onMatch={async (cand) => {
          const ok = await post({ action: 'match_lines', transactionIds: [...picked], target: { type: cand.type, id: cand.id } }, `${picked.size} lines matched to ${cand.number}`);
          if (ok) setMatching(false);
        }} busy={busy} />

      <Dialog open={excluding} onOpenChange={setExcluding}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Exclude {picked.size} transaction{picked.size === 1 ? '' : 's'}?</DialogTitle>
            <DialogDescription>An excluded line stays out of the reconciliation, with the reason below, until it is restored.</DialogDescription>
          </DialogHeader>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional): a duplicate in the statement" data-slot="exclude-reason-input" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setExcluding(false)}>Cancel</Button>
            <Button disabled={busy} onClick={async () => { if (await post({ action: 'exclude', transactionIds: [...picked], reason: reason.trim() || null }, 'Excluded')) setExcluding(false); }} data-slot="exclude-confirm">Exclude</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TabButton({ active, onClick, title, sub, slot }: { active: boolean; onClick: () => void; title: React.ReactNode; sub: string; slot: string }) {
  return (
    <button type="button" onClick={onClick} data-slot="account-tab" data-tab={slot}
      className={cn('px-4 py-2 text-left', active && 'rounded-t-md border border-b-0 bg-surface')}>
      <span className="block text-[15px]">{title}</span><span className="block text-[12px] text-muted-foreground">{sub}</span>
    </button>
  );
}

function Pill({ active, onClick, children, slot }: { active: boolean; onClick: () => void; children: React.ReactNode; slot: string }) {
  return (
    <button type="button" onClick={onClick} data-slot="line-pill" data-pill={slot}
      className={cn('rounded-full border px-3 py-0.5 text-[12px]', active ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted')}>
      {children}
    </button>
  );
}

/** Multi-Select & Match: the transactions in the books the chosen lines could together be. */
function MatchTogetherDialog({ open, onClose, accountId, direction, totalPaise, onMatch, busy }: {
  open: boolean; onClose: () => void; accountId: string; direction: 'in' | 'out'; totalPaise: number; onMatch: (c: Candidate) => void; busy: boolean;
}) {
  const cands = useApi<{ candidates: Candidate[] }>(
    () => (open ? api.get(`/api/banking/accounts/${accountId}/candidates`, { direction }) : Promise.resolve({ candidates: [] })), [open, accountId, direction],
  );
  const list = [...(cands.data?.candidates ?? [])].sort((a, b) => Number(b.amountPaise === totalPaise) - Number(a.amountPaise === totalPaise));
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl" data-slot="match-together">
        <DialogHeader>
          <DialogTitle>Match the selected lines</DialogTitle>
          <DialogDescription>The lines add up to {formatINR(totalPaise)}. Pick the one transaction in the books they are, for exactly that amount.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] overflow-y-auto rounded-md border">
          {cands.loading ? <div className="p-4"><LoadingRows rows={4} /></div> : list.length === 0 ? (
            <p className="p-6 text-center text-[13px] text-muted-foreground">Nothing in the books through this account is open to match.</p>
          ) : list.map((cand) => {
            const exact = cand.amountPaise === totalPaise;
            return (
              <button key={cand.key} type="button" disabled={!exact || busy} onClick={() => onMatch(cand)} data-slot="together-candidate" data-exact={exact ? '1' : '0'}
                className={cn('flex w-full items-center gap-3 border-b px-4 py-2.5 text-left text-[13px] last:border-0', exact ? 'hover:bg-row-hover' : 'opacity-50')}>
                <span className="min-w-0 flex-1"><span className="block">{cand.number} · {cand.type === 'journal' ? 'Journal' : cand.type.charAt(0).toUpperCase() + cand.type.slice(1)}</span>
                  <span className="block text-[11px] text-muted-foreground">{day(cand.date)}{cand.party ? ` · ${cand.party}` : ''}</span></span>
                <span className="tabular">{formatINR(cand.amountPaise)}</span>
              </button>
            );
          })}
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Zoho's Dashboard tab: the account's summary and its balance over the period. */
function AccountDashboard({ accountId, kind, counts }: { accountId: string; kind: string; counts: Head['counts'] }) {
  const [period, setPeriod] = useState<'30d' | '12m'>('30d');
  const o = useApi<{ chart: { points: string[]; series: Record<string, number[]> }; tiles: { key: string; amountPaise: number }[] }>(
    () => api.get('/api/banking/overview', { account: accountId, period }), [accountId, period],
  );
  const key = kind === 'card' ? 'card' : kind === 'cash' || kind === 'wallet' ? 'cash' : kind === 'clearing' ? 'clearing' : 'bank';
  const data = (o.data?.chart.points ?? []).map((p, i) => ({
    day: new Date(`${p}T00:00:00`).toLocaleDateString('en-IN', period === '30d' ? { day: '2-digit', month: 'short' } : { month: 'short', year: '2-digit' }),
    balance: (o.data!.chart.series[key]?.[i] ?? 0) / 100,
  }));
  return (
    <div className="space-y-5 px-5 py-5" data-slot="account-dashboard">
      <div className="flex flex-wrap gap-8 text-[13px]">
        <span><span className="block text-muted-foreground">Uncategorized Transactions</span><span className="block text-[18px] font-medium">{counts.uncategorized}</span></span>
        <span><span className="block text-muted-foreground">Best Matches</span><span className="block text-[18px] font-medium">{counts.bestMatches}</span></span>
        <span><span className="block text-muted-foreground">Recognized</span><span className="block text-[18px] font-medium">{counts.recognized}</span></span>
        <span><span className="block text-muted-foreground">Excluded</span><span className="block text-[18px] font-medium">{counts.excluded}</span></span>
        <span className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center gap-1 outline-none">{period === '30d' ? 'Last 30 days' : 'Last 12 months'} <ChevronDown className="size-3" /></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setPeriod('30d')}>Last 30 days</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setPeriod('12m')}>Last 12 months</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      <div className="h-[260px]" data-slot="account-chart">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="#ebeaf2" />
            <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#6c718a' }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={18} />
            <YAxis tick={{ fontSize: 11, fill: '#6c718a' }} tickLine={false} axisLine={false} width={64} tickFormatter={(v: number) => `${Math.round(v / 1000)}K`} />
            <ChartTooltip formatter={(v) => formatINR(Math.round(Number(v ?? 0) * 100))} />
            <Line type="monotone" dataKey="balance" name="Balance" stroke="#2f80ed" strokeWidth={1.8} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
