'use client';

// An employee's consents: what their personal data may be used for, when they
// agreed and how, and withdrawing it — as easily as it was given.

import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { cn } from '@/lib/utils';

interface Consent { id: string; purpose: string; label: string; notice: string; givenAt: string; givenBy: string | null; withdrawnAt: string | null; recordedBy: string | null }

const when = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

export function EmployeeConsents({ employeeId, canEdit }: { employeeId: string; canEdit: boolean }) {
  const state = useApi(() => api.get<{ notice: string; purposes: { key: string; label: string }[]; consents: Consent[] }>('/api/payroll/consents', { employeeId }), [employeeId]);
  const [how, setHow] = useState('Signed form');
  const call = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast.success(done);
      await state.refetch();
    } catch (e) {
      toast.error('Not done', { description: e instanceof Error ? e.message : String(e) });
    }
  };
  const d = state.data;
  if (!d) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        What this person has agreed their data may be used for. Record it when they sign or confirm; withdraw it when they ask.
        Notice version {d.notice}.
      </p>
      <ul className="divide-y rounded-md border text-sm">
        {d.purposes.map((p) => {
          const standing = d.consents.find((c) => c.purpose === p.key && !c.withdrawnAt);
          const last = d.consents.find((c) => c.purpose === p.key);
          return (
            <li key={p.key} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="flex-1">{p.label}</span>
              {standing ? (
                <Badge variant="outline" className="border-emerald-500/40 text-[10px] text-emerald-700 dark:text-emerald-300">
                  Given {when(standing.givenAt)}{standing.givenBy ? ` · ${standing.givenBy}` : ''}
                </Badge>
              ) : (
                <Badge variant="outline" className={cn('text-[10px]', last?.withdrawnAt ? 'border-amber-500/40 text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}>
                  {last?.withdrawnAt ? `Withdrawn ${when(last.withdrawnAt)}` : 'Not recorded'}
                </Badge>
              )}
              {canEdit && (standing
                ? <Button size="xs" variant="ghost" onClick={() => void call(() => api.patch('/api/payroll/consents', { id: standing.id }), 'Consent withdrawn')}>Withdraw</Button>
                : <Button size="xs" variant="outline" onClick={() => void call(() => api.post('/api/payroll/consents', { employeeId, purpose: p.key, givenBy: how }), 'Consent recorded')}>Record</Button>)}
            </li>
          );
        })}
      </ul>
      {canEdit && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Given by
          <Input value={how} onChange={(e) => setHow(e.target.value)} className="h-8 w-48" />
        </label>
      )}
    </div>
  );
}
