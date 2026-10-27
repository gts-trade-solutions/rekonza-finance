'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Transaction locking — one lock per module, each with its own date and reason,
// rather than a single blunt period close. Sales are usually finalised before
// purchases are, and one date forces you to wait for the slowest module.
//
// The lock is enforced by the posting engine, not by this screen. Every entry
// the app writes calls assertPeriodOpen first, so a locked module refuses
// backdated postings from every route at once — including ones added later.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import {
  BookOpen, Landmark, Lock, ReceiptIndianRupee, ShieldCheck, ShoppingCart, Unlock,
} from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import { transactionLocks, type TransactionLockRow } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';

const MODULE_INFO: Record<string, { label: string; icon: typeof Lock; blurb: string }> = {
  sales: {
    label: 'Sales',
    icon: ReceiptIndianRupee,
    blurb: 'Invoices, credit notes, payments received',
  },
  purchases: {
    label: 'Purchases',
    icon: ShoppingCart,
    blurb: 'Bills, expenses, vendor credits, payments made',
  },
  banking: { label: 'Banking', icon: Landmark, blurb: 'Imports, reconciliation, transfers' },
  accountant: { label: 'Accountant', icon: BookOpen, blurb: 'Manual journals and adjustments' },
};

const today = () => new Date().toISOString().slice(0, 10);

export default function TransactionLockingPage() {
  const canLock = usePermission('accountant', 'approve');
  const state = useApi<{ locks: TransactionLockRow[] }>(() => transactionLocks.list(), []);

  const [editing, setEditing] = useState<TransactionLockRow | null>(null);
  const [lockDate, setLockDate] = useState(today());
  const [reason, setReason] = useState('');

  const setLock = useApiAction(transactionLocks.set);

  const applyLock = async () => {
    if (!editing) return;
    const done = await setLock.run(editing.module, lockDate, reason || 'Period finalised');
    if (!done) {
      toast.error(setLock.error ?? 'The lock was not applied');
      return;
    }
    toast.success(`${MODULE_INFO[editing.module].label} locked`, {
      description: `Nothing can be posted on or before ${new Date(lockDate).toLocaleDateString('en-IN')}.`,
    });
    setEditing(null);
    setReason('');
    state.refetch();
  };

  const unlock = async (l: TransactionLockRow) => {
    const done = await setLock.run(l.module, null);
    if (!done) {
      toast.error(setLock.error ?? 'The lock was not removed');
      return;
    }
    toast.info(`${MODULE_INFO[l.module].label} unlocked`, {
      description: 'This action is recorded in the audit trail.',
    });
    state.refetch();
  };

  return (
    <>
      <PageHeader
        title="Transaction Locking"
        description="Freeze a module up to a date so finalised figures cannot change behind you. Each module locks separately, because sales are usually settled before purchases are."
      />

      <Card className="flex items-start gap-3 border-primary/30 bg-primary/5 p-4">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="text-sm">
          <p className="font-medium">Why locking matters</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Once you have filed a GST return or handed figures to your accountant, those numbers are public.
            If someone then backdates an invoice into that period, your filed return and your books silently stop
            agreeing — and you will not find out until an assessment. A lock makes that impossible rather than
            merely discouraged: the posting engine refuses the entry outright. Unlocking is allowed, but it is
            recorded in the audit trail with who did it and when.
          </p>
        </div>
      </Card>

      <AsyncPage state={state}>
        {(d) => {
          const lockedCount = d.locks.filter((l) => l.lockedUpto).length;
          return (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                {d.locks.map((l) => {
                  const info = MODULE_INFO[l.module];
                  const Icon = info.icon;
                  return (
                    <Card key={l.module} className={cn('accent-bar p-5', l.lockedUpto && 'border-primary/30')}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <Icon className="size-4 shrink-0 text-muted-foreground" />
                            <p className="font-medium">{info.label}</p>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">{info.blurb}</p>
                        </div>
                        <Badge
                          variant="outline"
                          className={cn('shrink-0 text-[10px]', l.lockedUpto && 'border-primary/40 text-primary')}
                        >
                          {l.lockedUpto ? 'Locked' : 'Open'}
                        </Badge>
                      </div>

                      <div className="mt-4 flex items-end justify-between gap-3 border-t pt-4">
                        <div className="min-w-0">
                          <p className="micro-label">Locked up to</p>
                          {l.lockedUpto ? (
                            <>
                              <p className="mt-1 text-sm font-medium tabular">
                                {new Date(l.lockedUpto).toLocaleDateString('en-IN', {
                                  day: 'numeric', month: 'long', year: 'numeric',
                                })}
                              </p>
                              <p className="mt-0.5 truncate text-xs text-muted-foreground">{l.reason}</p>
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                {l.protectedEntries} entr{l.protectedEntries === 1 ? 'y' : 'ies'} protected
                                {l.lockedBy ? ` · by ${l.lockedBy}` : ''}
                              </p>
                            </>
                          ) : (
                            <p className="mt-1 text-sm text-muted-foreground">Not locked</p>
                          )}
                        </div>
                        {canLock &&
                          (l.lockedUpto ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="gap-1.5"
                              disabled={setLock.busy}
                              onClick={() => void unlock(l)}
                            >
                              <Unlock className="size-3.5" /> Unlock
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              className="gap-1.5"
                              onClick={() => { setEditing(l); setLockDate(today()); setReason(''); }}
                            >
                              <Lock className="size-3.5" /> Lock
                            </Button>
                          ))}
                      </div>
                    </Card>
                  );
                })}
              </div>

              <p className="text-xs text-muted-foreground">
                {lockedCount} of {d.locks.length} modules locked. Only an admin or accountant can change a lock.
              </p>
            </>
          );
        }}
      </AsyncPage>

      <Dialog open={!!editing} onOpenChange={(v) => !v && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Lock {editing ? MODULE_INFO[editing.module].label : ''}</DialogTitle>
            <DialogDescription>
              Nothing dated on or before the lock date can be created, edited or voided in this module.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Field label="Lock transactions up to" required>
              <Input type="date" value={lockDate} onChange={(e) => setLockDate(e.target.value)} />
            </Field>
            <Field label="Reason" required hint="Shown to anyone who hits the lock, and stored in the audit trail">
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why this period is being locked"
              />
            </Field>
            {setLock.error && <p className="text-sm text-destructive">{setLock.error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={applyLock} disabled={setLock.busy}>
              {setLock.busy ? 'Locking…' : 'Lock module'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
