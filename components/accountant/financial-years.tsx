'use client';

// Financial years: close one when its checks pass, reopen the latest with a
// reason, and download any year's statements as one workbook.

import { useState } from 'react';
import { AlertCircle, CheckCircle2, Download, Loader2, Lock, Unlock } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Money } from '@/components/shared/money';
import { AsyncPage } from '@/components/shared/async-state';
import { api, type PeriodCloseResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

interface YearRow {
  fyStart: number; label: string; from: string; to: string; status: 'open' | 'closed' | 'current';
  closedAt: string | null; netProfitPaise: number | null; closingStockPaise: number | null;
  reopenReason: string | null; canReopen: boolean; canClose: boolean;
}

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function FinancialYears({ onChanged }: { onChanged?: () => void }) {
  const state = useApi(() => api.get<{ years: YearRow[] }>('/api/year-end'), []);
  const canClose = usePermission('accountant', 'approve');
  const [closing, setClosing] = useState<YearRow | null>(null);

  const reopen = async (y: YearRow) => {
    const reason = window.prompt(`Reopen FY ${y.label}? Its locks go back to the previous year end. Give a reason.`);
    if (!reason) return;
    try {
      await api.post('/api/year-end', { action: 'reopen', fy: y.fyStart, reason });
      toast.success(`FY ${y.label} reopened`, { description: 'Recorded in the audit trail.' });
      void state.refetch(); onChanged?.();
    } catch (e) {
      toast.error('Not reopened', { description: err(e) });
    }
  };

  return (
    <Card className="space-y-3 p-5">
      <div>
        <h3 className="text-sm font-semibold">Financial years</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Balances carry into the new year on their own — the ledger is continuous, and the year&apos;s profit reaches
          retained earnings in the balance sheet. Closing a year checks it, locks every module to 31 March, and keeps
          the trial balance as it stood. Close the years in order; only the latest closed year can be reopened.
        </p>
      </div>
      <AsyncPage state={state}>
        {(d) => (
          <ul className="divide-y rounded-md border">
            {d.years.map((y) => (
              <li key={y.fyStart} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
                <span className="w-24 font-medium">FY {y.label}</span>
                <Badge variant="outline" className={`text-[10px] ${y.status === 'closed' ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300' : y.status === 'current' ? '' : 'border-amber-500/40 text-amber-700 dark:text-amber-300'}`}>
                  {y.status === 'closed' ? 'Closed' : y.status === 'current' ? 'Current' : 'Ended, open'}
                </Badge>
                <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                  {y.status === 'closed' && y.netProfitPaise !== null && <>Profit <Money value={y.netProfitPaise} /> · closed {new Date(y.closedAt!).toLocaleDateString('en-IN')}</>}
                  {y.status !== 'closed' && y.reopenReason && <>Reopened: {y.reopenReason}</>}
                </span>
                <Button size="xs" variant="ghost" className="gap-1" asChild>
                  <a href={`/api/year-end?view=pack&fy=${y.fyStart}`}><Download className="size-3" /> Year pack</a>
                </Button>
                {canClose && y.canClose && (
                  <Button size="xs" className="gap-1" onClick={() => setClosing(y)}><Lock className="size-3" /> Close year</Button>
                )}
                {canClose && y.canReopen && (
                  <Button size="xs" variant="outline" className="gap-1" onClick={() => void reopen(y)}><Unlock className="size-3" /> Reopen</Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </AsyncPage>
      <CloseDialog year={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); void state.refetch(); onChanged?.(); }} />
    </Card>
  );
}

function CloseDialog({ year, onClose, onDone }: { year: YearRow | null; onClose: () => void; onDone: () => void }) {
  const checks = useApi(async () => (year ? api.get<PeriodCloseResponse>('/api/year-end', { view: 'checks', fy: year.fyStart }) : null), [year?.fyStart]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const blockers = checks.data?.checks.filter((c) => c.blocking && c.count > 0) ?? [];
  const unbalanced = blockers.some((b) => b.id === 'balance');

  const close = async () => {
    if (!year) return;
    setBusy(true);
    try {
      const r = await api.post<{ netProfitPaise: number }>('/api/year-end', { action: 'close', fy: year.fyStart, overrideReason: blockers.length ? reason : null });
      toast.success(`FY ${year.label} closed`, { description: `Profit for the year ₹${(r.netProfitPaise / 100).toLocaleString('en-IN')}. Every module is locked to ${year.to}.` });
      setReason('');
      onDone();
    } catch (e) {
      toast.error('Not closed', { description: err(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!year} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        {year && (
          <>
            <DialogHeader>
              <DialogTitle>Close FY {year.label}</DialogTitle>
              <DialogDescription>Every module is locked to {year.to}, and the trial balance at that date is kept with the year.</DialogDescription>
            </DialogHeader>
            {!checks.data ? (
              <p className="py-4 text-sm text-muted-foreground">{checks.error ?? 'Checking…'}</p>
            ) : (
              <ul className="max-h-80 space-y-1.5 overflow-y-auto text-sm thin-scroll">
                {checks.data.checks.map((c) => (
                  <li key={c.id} className="flex items-start gap-2">
                    {c.count === 0
                      ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                      : <AlertCircle className={`mt-0.5 size-4 shrink-0 ${c.blocking ? 'text-destructive' : 'text-amber-600'}`} />}
                    <span><span className="font-medium">{c.label}</span><span className="block text-xs text-muted-foreground">{c.detail}</span></span>
                  </li>
                ))}
              </ul>
            )}
            {blockers.length > 0 && !unbalanced && (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Some checks have not passed. Close anyway only with a reason the auditor will read.</p>
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why the year is being closed regardless" />
              </div>
            )}
            {unbalanced && <p className="text-sm text-destructive">The trial balance does not agree, so the year cannot be closed.</p>}
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button onClick={() => void close()} disabled={busy || !checks.data || unbalanced || (blockers.length > 0 && reason.trim().length < 5)}>
                {busy && <Loader2 className="size-4 animate-spin" />} Close the year
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
