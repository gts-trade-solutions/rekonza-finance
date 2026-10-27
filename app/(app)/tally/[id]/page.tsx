'use client';

// ─────────────────────────────────────────────────────────────────────────────
// One Tally company, as its accountant knows it: Day Book, ledgers, Trial
// Balance, Profit & Loss A/c, Balance Sheet and Stock Summary.
//
// The date the figures are as at, and when the company last synced, sit at the
// top of every tab — a Tally balance sheet read here is a copy, and a copy is
// only as good as its date. The tab and the open ledger live in the address, so
// a page can be refreshed, bookmarked or sent without losing the place.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Lock, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { AsyncPage } from '@/components/shared/async-state';
import { DayBook } from '@/components/tally/day-book';
import { LedgerList, LedgerVouchers } from '@/components/tally/ledgers';
import { BalanceSheet, ProfitAndLoss, StockSummary, TrialBalance } from '@/components/tally/statements';
import { ago, longDate } from '@/components/tally/format';
import { tally, type TallyOverview } from '@/lib/api/tally';
import { useApi } from '@/lib/api/use-api';
import type { RangeValue } from '@/lib/date-range';
import { cn } from '@/lib/utils';

const TABS = [
  { key: 'day-book', label: 'Day Book' },
  { key: 'ledgers', label: 'Ledgers' },
  { key: 'trial-balance', label: 'Trial Balance' },
  { key: 'profit-loss', label: 'Profit & Loss A/c' },
  { key: 'balance-sheet', label: 'Balance Sheet' },
  { key: 'stock', label: 'Stock Summary' },
] as const;
type Tab = (typeof TABS)[number]['key'];

export default function TallyCompanyPage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<TallyOverview>(() => tally.overview(), []);
  const [tab, setTab] = useState<Tab>('day-book');
  const [ledgerId, setLedgerId] = useState<string | null>(null);
  const [range, setRange] = useState<RangeValue | null>(null);

  // The place in the address: read once, written on every move.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const t = p.get('view') as Tab | null;
    if (t && TABS.some((x) => x.key === t)) setTab(t);
    setLedgerId(p.get('ledger'));
  }, []);
  const go = useCallback((next: Tab, ledger: string | null = null) => {
    setTab(next);
    setLedgerId(ledger);
    const p = new URLSearchParams({ view: next, ...(ledger ? { ledger } : {}) });
    window.history.replaceState(null, '', `${window.location.pathname}?${p}`);
  }, []);
  const openLedger = useCallback((ledger: string) => go('ledgers', ledger), [go]);

  return (
    <AsyncPage state={state}>
      {(d) => {
        const company = d.companies.find((c) => c.id === id);
        if (!company) {
          return (
            <Card className="p-8 text-center text-sm text-muted-foreground">
              That Tally company is not connected to this organisation. <Link href="/tally" className="text-primary underline">Back to Tally</Link>
            </Card>
          );
        }
        // Periods open on the month the figures are as at — the one being worked on.
        const asOf = company.asOf ?? new Date().toISOString().slice(0, 10);
        const current: RangeValue = range ?? { from: `${asOf.slice(0, 8)}01`, to: asOf, mode: 'custom' };
        const stale = !company.lastSyncedAt || Date.now() - new Date(company.lastSyncedAt).getTime() > 24 * 3600_000;

        return (
          <div className="space-y-5">
            <div className="flex flex-col gap-3 border-b pb-5">
              <Link href="/tally" className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                <ArrowLeft className="size-3" /> Tally
              </Link>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <div className="accent-bar min-w-0 flex-1">
                  <h1 className="display-xl">{company.name}</h1>
                  <p className="mt-1.5 text-[13px] text-muted-foreground">
                    {[company.gstin, company.stateName].filter(Boolean).join(' · ')}
                    {company.asOf ? ` · figures as at ${longDate(company.asOf)}` : ''}
                    {company.connectorName ? ` · from ${company.connectorName}` : ''}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="gap-1 text-[10px]">
                    <Lock className="size-3" /> Read-only · entries are made in Tally
                  </Badge>
                  <Badge
                    variant="outline"
                    className={cn('text-[10px]', stale ? 'border-warning/50 text-warning' : 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300')}
                    data-slot="tally-freshness"
                  >
                    Synced {ago(company.lastSyncedAt)}
                  </Badge>
                </div>
              </div>
              {company.lastError && (
                <p className="flex items-center gap-1.5 text-xs text-destructive">
                  <TriangleAlert className="size-3.5" /> The connector reported: {company.lastError}
                </p>
              )}
            </div>

            <div className="thin-scroll -mx-1 overflow-x-auto px-1">
              <div className="flex w-max gap-1 border-b" role="tablist">
                {TABS.filter((t) => t.key !== 'stock' || company.maintainsInventory || company.stockItems > 0).map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.key}
                    onClick={() => go(t.key)}
                    className={cn(
                      '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors',
                      tab === t.key ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
                    )}
                    data-slot="tally-tab"
                    data-tab={t.key}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {tab === 'day-book' && <DayBook companyId={company.id} range={current} onRange={setRange} />}
            {tab === 'ledgers' &&
              (ledgerId ? (
                <LedgerVouchers
                  companyId={company.id}
                  ledgerId={ledgerId}
                  range={range ?? { from: company.fyFrom ?? current.from, to: asOf, mode: 'custom' }}
                  onRange={setRange}
                  onBack={() => go('ledgers')}
                />
              ) : (
                <LedgerList companyId={company.id} onOpen={openLedger} />
              ))}
            {tab === 'trial-balance' && <TrialBalance companyId={company.id} onOpenLedger={openLedger} />}
            {tab === 'profit-loss' && <ProfitAndLoss companyId={company.id} onOpenLedger={openLedger} />}
            {tab === 'balance-sheet' && <BalanceSheet companyId={company.id} onOpenLedger={openLedger} />}
            {tab === 'stock' && <StockSummary companyId={company.id} />}
          </div>
        );
      }}
    </AsyncPage>
  );
}
