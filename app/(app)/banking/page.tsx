'use client';

// Zoho Books' Banking Overview, from the books (services/bank-overview.ts).
//
// The four balances, the uncategorised count, the balance chart and the
// accounts, as Zoho lays them out. Every balance is what has been posted to
// the account's ledger account, not a stored figure: a cached balance is a
// second copy of the truth, and the moment one entry is reversed the two
// disagree with nothing to say which is right. "Amount in Bank" is what the
// bank last said, from the running balance on the latest statement imported.
//
// Zoho keeps the sidebar open on the overview (it folds only on an account's
// page), so this page does not fold it.
//
// Automatic feeds are absent on purpose: pulling transactions from an Indian
// bank means an Account Aggregator, and registering as a Financial Information
// User requires being regulated by the RBI, SEBI, IRDAI or PFRDA — which
// accounting software is not. Statement import is the honest route.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeftRight, CalendarDays, ChevronDown, ChevronUp, CircleCheck, CreditCard, FileClock, FileSpreadsheet, HandCoins,
  Landmark, ListChecks, ScrollText, Search, TrendingUp, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage, LoadingRows, Refreshing } from '@/components/shared/async-state';
import { usePermission } from '@/lib/store/hooks';
import { formatINR } from '@/lib/money';
import { api, ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { cn } from '@/lib/utils';

type TileKey = 'bank' | 'card' | 'cash' | 'clearing';
interface AccountRow {
  id: string; kind: string; name: string; code: string | null; accountNumber: string | null; accountLast4: string | null;
  bankName: string | null; isPrimary: boolean; isActive: boolean; balancePaise: number; amountInBankPaise: number | null;
  amountInBankOn: string | null; unmatchedCount: number;
}
interface Overview {
  period: '30d' | '12m';
  accountId: string | null;
  tiles: { key: TileKey; amountPaise: number; accounts: number }[];
  uncategorized: number;
  chart: { points: string[]; series: Record<TileKey, number[]> };
  accounts: AccountRow[];
}

/** Zoho's four tiles: the label, its icon and its colours (and the chart's line). */
const TILE: Record<TileKey, { label: string; icon: typeof Landmark; tint: string; line: string }> = {
  bank: { label: 'Bank Balance', icon: Landmark, tint: 'bg-[#e3f6ec] text-[#21b26b]', line: '#21b26b' },
  card: { label: 'Card Balance', icon: CreditCard, tint: 'bg-[#efe8fc] text-[#8f5be8]', line: '#8f5be8' },
  cash: { label: 'Cash In Hand', icon: HandCoins, tint: 'bg-[#eeeff3] text-[#6c718a]', line: '#9ba0b5' },
  clearing: { label: 'Payment Clearing', icon: CircleCheck, tint: 'bg-[#e3edfd] text-[#2f80ed]', line: '#2f80ed' },
};

/** Rekonza's own banking screens, kept under More beside Zoho's. */
const EXTRAS = [
  { href: '/banking/statement-lines', icon: ListChecks, label: 'Statement lines', hint: 'Categorise, exclude or delete many lines at once' },
  { href: '/banking/transfers', icon: ArrowLeftRight, label: 'Transfers (contra)', hint: 'Cash deposited, withdrawn, bank to bank' },
  { href: '/banking/cheques', icon: FileClock, label: 'Cheques & PDC', hint: 'In hand and post-dated' },
  { href: '/banking/reconcile', icon: ScrollText, label: 'Reconcile all accounts', hint: 'Every account’s statement lines in one place' },
  { href: '/reports/bank-statement', icon: ScrollText, label: 'Bank statement as on date', hint: 'Books to bank on any day' },
];

const short = (iso: string, period: '30d' | '12m') => {
  const d = new Date(`${iso}T00:00:00`);
  return period === '30d'
    ? d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
    : d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
};
/** The chart's axis in Zoho's short form: 1.2 K, 3.4 L, 1.1 Cr. */
const compact = (rupees: number) => {
  const a = Math.abs(rupees);
  const s = a >= 1e7 ? `${+(a / 1e7).toFixed(2)} Cr` : a >= 1e5 ? `${+(a / 1e5).toFixed(2)} L` : a >= 1e3 ? `${+(a / 1e3).toFixed(2)} K` : `${Math.round(a)}`;
  return rupees < 0 ? `-${s}` : s;
};
const accountNo = (a: Pick<AccountRow, 'accountNumber' | 'accountLast4' | 'code'>) =>
  a.accountNumber ? a.accountNumber.slice(-5) : a.accountLast4 ?? a.code ?? '';

export default function BankingPage() {
  const router = useRouter();
  const canCreate = usePermission('banking', 'create');
  const canEdit = usePermission('banking', 'edit');
  const canDelete = usePermission('banking', 'void');
  const [period, setPeriod] = useState<'30d' | '12m'>('30d');
  const [scope, setScope] = useState('');
  const [status, setStatus] = useState<'active' | 'inactive' | 'all'>('active');
  const [chartOn, setChartOn] = useState(true);
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState('');
  useEffect(() => { try { setChartOn(localStorage.getItem('rekonza-bank-chart') !== '0'); } catch { /* private mode */ } }, []);
  const toggleChart = () => setChartOn((on) => { try { localStorage.setItem('rekonza-bank-chart', on ? '0' : '1'); } catch { /* ignore */ } return !on; });

  const state = useApi<Overview>(
    () => api.get('/api/banking/overview', { period, account: scope || undefined, status }),
    [period, scope, status],
  );
  // The switcher lists every active account whatever the table shows.
  const active = useApi<{ accounts: AccountRow[] }>(() => api.get('/api/banking/accounts'), []);

  const chartData = useMemo(() => {
    const c = state.data?.chart;
    if (!c) return [];
    return c.points.map((p, i) => ({
      day: short(p, state.data!.period), bank: c.series.bank[i] / 100, card: c.series.card[i] / 100, cash: c.series.cash[i] / 100, clearing: c.series.clearing[i] / 100,
    }));
  }, [state.data]);

  const firstWaiting = (state.data?.accounts ?? []).find((a) => a.unmatchedCount > 0);
  const categorizeHref = scope
    ? `/banking/transactions?account_id=${scope}&filter_by=Status.Uncategorized`
    : firstWaiting ? `/banking/transactions?account_id=${firstWaiting.id}&filter_by=Status.Uncategorized` : '/banking/reconcile';

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast.success(ok); await Promise.all([state.refetch(), active.refetch()]); }
    catch (e) { toast.error(e instanceof ApiError ? e.message : 'That did not work.'); }
  };

  const scopeName = scope ? (active.data?.accounts ?? []).find((a) => a.id === scope)?.name ?? 'Account' : 'All Accounts';
  const rows = (state.data?.accounts ?? []).filter((a) => !search.trim() || `${a.name} ${a.bankName ?? ''} ${a.accountNumber ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <>
      <PageHeader
        title="Banking Overview"
        description="Balances are what the books say, not a stored figure — every one is the sum of what has been posted to that account."
        actions={
          <>
            <Refreshing active={state.refreshing} />
            {canCreate && <Button size="sm" asChild data-slot="add-manually"><Link href="/banking/new">Add Manually</Link></Button>}
            <Button variant="outline" size="sm" asChild data-slot="manage-rules"><Link href="/banking/rules">Manage Transaction Rules</Link></Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1" data-slot="banking-more">More <ChevronDown className="size-3.5" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuItem asChild>
                  <Link href="/banking/imports" className="gap-2.5" data-slot="more-import"><FileSpreadsheet className="size-4" /> Import Statement</Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {EXTRAS.map((x) => (
                  <DropdownMenuItem key={x.href} asChild>
                    <Link href={x.href} className="items-start gap-2.5 py-2">
                      <x.icon className="mt-0.5 size-4 shrink-0" />
                      <span className="min-w-0"><span className="block">{x.label}</span><span className="block text-[11px] opacity-75">{x.hint}</span></span>
                    </Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <AsyncPage state={state} loading={<LoadingRows rows={6} />}>
        {(data) => (
          <>
            {/* Zoho's overview box: the scope and period, the four balances, the uncategorised count, the chart. */}
            <section className="rounded-[var(--radius-card)] border bg-surface" data-slot="banking-overview">
              <div className="mx-4 flex items-center justify-between gap-3 border-b py-4">
                <DropdownMenu>
                  <DropdownMenuTrigger className="inline-flex items-center gap-1.5 text-[18px] font-medium outline-none" data-slot="overview-scope">
                    {scopeName} <ChevronDown className="size-4 text-link" strokeWidth={2.4} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-64">
                    <DropdownMenuItem onClick={() => setScope('')}>All Accounts</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {(active.data?.accounts ?? []).map((a) => (
                      <DropdownMenuItem key={a.id} onClick={() => setScope(a.id)}>{a.name}</DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <DropdownMenu>
                  <DropdownMenuTrigger className="inline-flex items-center gap-1.5 text-[13px] outline-none" data-slot="overview-period">
                    <CalendarDays className="size-4" strokeWidth={1.6} /> {period === '30d' ? 'Last 30 days' : 'Last 12 months'} <ChevronDown className="size-3 text-link" strokeWidth={2.6} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setPeriod('30d')}>Last 30 days</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setPeriod('12m')}>Last 12 months</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-4 px-5 py-6">
                {data.tiles.map((t) => {
                  const tile = TILE[t.key];
                  return (
                    <div key={t.key} className="flex items-center gap-3 pr-4" data-slot="banking-total" data-tile={t.key}
                      title={`${t.accounts} account${t.accounts === 1 ? '' : 's'}`}>
                      <span className={cn('grid size-11 shrink-0 place-items-center rounded-lg', tile.tint)}><tile.icon className="size-5" strokeWidth={1.6} /></span>
                      <span>
                        <span className="block text-[13px]">{tile.label}</span>
                        <span className="block text-[15px] font-medium tabular">{formatINR(t.amountPaise)}</span>
                      </span>
                    </div>
                  );
                })}
                <div className="ml-auto flex items-center gap-3" data-slot="uncategorized-tile">
                  <span className={cn('grid h-11 min-w-11 place-items-center rounded-lg px-2 text-[20px] font-medium tabular',
                    data.uncategorized > 0 ? 'bg-[#fde3e4] text-[#d6141d]' : 'bg-[#e3f6ec] text-[#21b26b]')}>
                    {data.uncategorized}
                  </span>
                  <span>
                    <span className="block text-[14px]">Uncategorized Transactions</span>
                    <Link href={categorizeHref} className="text-[13px] text-link hover:underline" data-slot="categorize-now">Categorize now ›</Link>
                  </span>
                </div>
              </div>
              <div className="px-5 pb-5">
                <button type="button" onClick={toggleChart} className="inline-flex items-center gap-1.5 text-[13px] text-link" data-slot="chart-toggle">
                  <TrendingUp className="size-4" /> {chartOn ? 'Hide Chart' : 'Show Chart'} {chartOn ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                </button>
                {chartOn && (
                  <div className="mt-3" data-slot="balance-chart">
                    <div className="h-[260px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                          <CartesianGrid vertical={false} stroke="#ebeaf2" />
                          <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#6c718a' }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={18} />
                          <YAxis tickFormatter={compact} tick={{ fontSize: 11, fill: '#6c718a' }} tickLine={false} axisLine={false} width={56} />
                          <ChartTooltip formatter={(v) => formatINR(Math.round(Number(v ?? 0) * 100))} />
                          {(Object.keys(TILE) as TileKey[]).map((k) => (
                            <Line key={k} type="monotone" dataKey={k} name={TILE[k].label} stroke={TILE[k].line} strokeWidth={1.6} dot={false} />
                          ))}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-4 pl-10 text-[13px]">
                      {(Object.keys(TILE) as TileKey[]).map((k) => (
                        <span key={k} className="inline-flex items-center gap-1.5"><span className="size-2 rounded-[2px]" style={{ background: TILE[k].line }} />{TILE[k].label}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* Zoho's "Active Accounts ▾" table. */}
            <section className="space-y-2" data-slot="banking-accounts">
              <DropdownMenu>
                <DropdownMenuTrigger className="inline-flex items-center gap-1.5 px-2 text-[18px] font-medium outline-none" data-slot="accounts-status">
                  {status === 'active' ? 'Active Accounts' : status === 'inactive' ? 'Inactive Accounts' : 'All Accounts'} <ChevronDown className="size-4 text-link" strokeWidth={2.4} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onClick={() => setStatus('active')}>Active Accounts</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setStatus('inactive')}>Inactive Accounts</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setStatus('all')}>All Accounts</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {data.accounts.length === 0 ? (
                <EmptyState icon={Landmark} title={status === 'inactive' ? 'No inactive accounts' : 'No accounts yet'}
                  description={status === 'inactive' ? 'An account marked inactive is listed here.' : 'Add the bank accounts and cards the business actually uses.'} />
              ) : (
                <div className="overflow-x-auto border-y thin-scroll">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="border-b bg-table-head text-left text-[11px] font-semibold uppercase text-table-head-foreground">
                        <th className="px-4 py-2.5 font-semibold">Account Details</th>
                        <th className="px-4 py-2.5 font-semibold">Uncategorized</th>
                        <th className="px-4 py-2.5 text-right font-semibold">Amount in Bank</th>
                        <th className="px-4 py-2.5 text-right font-semibold">Amount in Rekonza</th>
                        <th className="w-24 px-4 py-2 text-right">
                          {searching ? (
                            <span className="inline-flex items-center gap-1">
                              <Input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" className="h-7 w-40 text-[12px] normal-case" data-slot="accounts-search" />
                              <button type="button" aria-label="Close search" onClick={() => { setSearching(false); setSearch(''); }}><X className="size-3.5" /></button>
                            </span>
                          ) : (
                            <button type="button" aria-label="Search accounts" onClick={() => setSearching(true)} className="text-muted-foreground hover:text-foreground" data-slot="accounts-search-open"><Search className="size-3.5" /></button>
                          )}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((a) => {
                        const Icon = a.kind === 'card' ? CreditCard : a.kind === 'cash' || a.kind === 'wallet' ? HandCoins : Landmark;
                        return (
                          <tr key={a.id} className="border-b last:border-0 hover:bg-row-hover" data-slot="bank-account-row">
                            <td className="px-4 py-3">
                              <span className="flex items-center gap-3">
                                <span className="grid size-8 shrink-0 place-items-center text-muted-foreground"><Icon className="size-5" strokeWidth={1.5} /></span>
                                <span className="min-w-0">
                                  <Link href={`/banking/transactions?account_id=${a.id}`} className="text-[14px] text-link hover:underline" data-slot="account-link">{a.name}</Link>
                                  {a.isPrimary && <span className="ml-2 text-[10px] font-semibold uppercase text-success">Primary</span>}
                                  {!a.isActive && <span className="ml-2 text-[10px] font-semibold uppercase text-muted-foreground">Inactive</span>}
                                  <span className="block text-[12px] text-muted-foreground">{accountNo(a)}</span>
                                </span>
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              {a.unmatchedCount > 0 ? (
                                <Link href={`/banking/transactions?account_id=${a.id}&filter_by=Status.Uncategorized`} className="text-[#d6141d] hover:underline">
                                  {a.unmatchedCount} transaction{a.unmatchedCount === 1 ? '' : 's'}
                                </Link>
                              ) : null}
                            </td>
                            <td className="px-4 py-3 text-right tabular" title={a.amountInBankOn ? `As the statement said on ${a.amountInBankOn}` : 'No statement balance imported yet'}>
                              {a.amountInBankPaise == null ? <span className="text-muted-foreground">—</span> : formatINR(a.amountInBankPaise)}
                            </td>
                            <td className="px-4 py-3 text-right tabular">{formatINR(a.balancePaise)}</td>
                            <td className="px-4 py-3 text-right">
                              <DropdownMenu>
                                <DropdownMenuTrigger aria-label={`More for ${a.name}`} className="inline-grid size-6 place-items-center rounded-full border text-muted-foreground outline-none hover:text-foreground" data-slot="account-row-menu">
                                  <ChevronDown className="size-3.5" />
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-48">
                                  <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">{a.name}</DropdownMenuLabel>
                                  <DropdownMenuItem onClick={() => router.push(`/banking/imports?account=${a.id}`)}>Import Statement</DropdownMenuItem>
                                  {canEdit && <DropdownMenuItem onClick={() => router.push(`/banking/${a.id}/edit`)}>Edit</DropdownMenuItem>}
                                  <DropdownMenuItem onClick={() => router.push(`/banking/reconcile?account=${a.id}`)}>Reconcile</DropdownMenuItem>
                                  {canEdit && (a.isActive
                                    ? <DropdownMenuItem onClick={() => void act(() => api.patch(`/api/banking/accounts/${a.id}`, { isActive: false }), `${a.name} marked as inactive`)}>Mark as Inactive</DropdownMenuItem>
                                    : <DropdownMenuItem onClick={() => void act(() => api.patch(`/api/banking/accounts/${a.id}`, { isActive: true }), `${a.name} marked as active`)}>Mark as Active</DropdownMenuItem>)}
                                  {canDelete && <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => {
                                    if (window.confirm(`Delete ${a.name}? Only an account nothing has been posted to can be deleted.`)) void act(() => api.delete(`/api/banking/accounts/${a.id}`), `${a.name} deleted`);
                                  }}>Delete</DropdownMenuItem>}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <p className="flex items-start gap-2 px-1 text-[12px] leading-relaxed text-muted-foreground">
              <Landmark className="mt-0.5 size-3.5 shrink-0" />
              Automatic bank feeds need a licensed Account Aggregator, which accounting software cannot be. Import a statement instead:
              re-importing an overlapping one is safe, as lines already present are skipped rather than doubled.
            </p>
          </>
        )}
      </AsyncPage>
    </>
  );
}
