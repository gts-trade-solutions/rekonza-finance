'use client';

// Period close.
//
// Every check on this page is a live query, not a box somebody ticks. A ticked
// box records what you believed when you ticked it; these say what is true
// right now, which is the only version worth blocking a close on.
//
// "Closing" a period is applying a transaction lock across all four modules.
// The lock is enforced by the posting engine, so once it is on, no screen and
// no endpoint can date an entry into the closed period.

import { useMemo } from 'react';
import Link from 'next/link';
import {
  AlertCircle, ArrowRight, CalendarClock, CheckCircle2, Lock, Unlock,
} from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage } from '@/components/shared/async-state';
import {
  periodClose, transactionLocks,
  type PeriodCloseResponse, type TransactionLockRow,
} from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { FinancialYears } from '@/components/accountant/financial-years';

const MODULES = ['sales', 'purchases', 'banking', 'accountant'] as const;

export default function PeriodClosePage() {
  const canClose = usePermission('accountant', 'approve');

  const period = useMemo(() => {
    const d = new Date();
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return {
      label: d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
      from: new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10),
      // The whole month, so locking it closes the period rather than today.
      to: last.toISOString().slice(0, 10),
    };
  }, []);

  const state = useApi<PeriodCloseResponse>(
    () => periodClose.status(period.from, period.to),
    [period.from, period.to],
  );
  const locks = useApi<{ locks: TransactionLockRow[] }>(() => transactionLocks.list(), []);
  const setLock = useApiAction(transactionLocks.set);

  // Closed means every module is locked at least to the end of this period.
  const closed = (locks.data?.locks ?? []).length > 0
    && (locks.data?.locks ?? []).every((l) => l.lockedUpto && l.lockedUpto >= period.to);

  const close = async () => {
    for (const m of MODULES) {
      const done = await setLock.run(m, period.to, `${period.label} closed`);
      if (!done) {
        toast.error(setLock.error ?? `${m} could not be locked`);
        return;
      }
    }
    toast.success(`${period.label} locked`, {
      description: 'No further entries can be posted into this period, from any screen.',
    });
    locks.refetch();
  };

  const reopen = async () => {
    for (const m of MODULES) {
      const done = await setLock.run(m, null);
      if (!done) {
        toast.error(setLock.error ?? `${m} could not be reopened`);
        return;
      }
    }
    toast.info('Period reopened', { description: 'This action is recorded in the audit trail.' });
    locks.refetch();
  };

  return (
    <>
      <PageHeader
        title="Period close"
        description={`Run through the checklist, then lock ${period.label} so nobody can quietly change last month's numbers.`}
        actions={
          canClose &&
          (closed ? (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={setLock.busy}
              onClick={() => void reopen()}
            >
              <Unlock className="size-3.5" /> Reopen period
            </Button>
          ) : (
            <Button
              size="sm"
              className="gap-1.5"
              disabled={setLock.busy || !state.data || state.data.blockers > 0}
              onClick={() => void close()}
            >
              <Lock className="size-3.5" /> {setLock.busy ? 'Locking…' : `Lock ${period.label}`}
            </Button>
          ))
        }
      />

      <AsyncPage state={state}>
        {(d) => (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Card className="p-4">
                <p className="text-xs text-muted-foreground">Period</p>
                <p className="mt-1 text-xl font-semibold">{period.label}</p>
                <Badge
                  variant="outline"
                  className={`mt-2 text-[10px] ${closed ? 'border-emerald-500/40' : 'border-amber-500/40'}`}
                >
                  {closed ? 'Locked' : 'Open'}
                </Badge>
              </Card>
              <Card className="p-4">
                <p className="text-xs text-muted-foreground">Checks passed</p>
                <p className="mt-1 text-xl font-semibold tabular">
                  {d.passed} of {d.checks.length}
                </p>
              </Card>
              <Card
                className={
                  'p-4 ' +
                  (d.blockers
                    ? 'border-destructive/40 bg-destructive/5'
                    : 'border-emerald-500/40 bg-emerald-500/5')
                }
              >
                <p className="text-xs text-muted-foreground">Blocking issues</p>
                <p className="mt-1 text-xl font-semibold tabular">{d.blockers}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {d.blockers ? 'Must be cleared before locking' : 'Ready to close'}
                </p>
              </Card>
            </div>

            <div className="space-y-2">
              {d.checks.map((c) => {
                const ok = c.count === 0;
                return (
                  <Card
                    key={c.id}
                    className={'flex flex-wrap items-center gap-4 p-4 ' + (!ok && c.blocking ? 'border-destructive/30' : '')}
                  >
                    {ok ? (
                      <CheckCircle2 className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <AlertCircle
                        className={'size-5 shrink-0 ' + (c.blocking ? 'text-destructive' : 'text-amber-600 dark:text-amber-400')}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium">{c.label}</p>
                        {!ok && c.blocking && (
                          <Badge variant="outline" className="border-destructive/40 text-[9px]">Blocking</Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">{c.detail}</p>
                    </div>
                    {!ok && c.href && (
                      <Button variant="outline" size="sm" asChild className="gap-1">
                        <Link href={c.href}>Fix <ArrowRight className="size-3" /></Link>
                      </Button>
                    )}
                  </Card>
                );
              })}
            </div>
          </>
        )}
      </AsyncPage>

      <FinancialYears onChanged={() => void locks.refetch()} />

      <Card className="flex items-start gap-3 border-primary/30 bg-primary/5 p-4">
        <CalendarClock className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="text-sm">
          <p className="font-medium">What locking a period actually does</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Once a month is locked, no new entry can be dated into it — the posting engine refuses it, so there is
            no screen that can slip past. That matters because reports and tax returns for that month have already
            gone out: if someone backdates an invoice afterwards, your filed figures and your books silently stop
            agreeing. Only an admin can reopen a locked period, and doing so is itself recorded in the audit trail.
            For finer control, lock modules individually under{' '}
            <Link href="/accountant/transaction-locking" className="text-primary hover:underline">
              Transaction Locking
            </Link>
            .
          </p>
        </div>
      </Card>
    </>
  );
}
