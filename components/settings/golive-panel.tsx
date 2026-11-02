'use client';

// The go-live check (lib/server/golive.ts) for admins: is this server set up to
// keep real books — what is ready, what is missing, and what to do about each.

import { AlertTriangle, CheckCircle2, ClipboardList, RefreshCw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { cn } from '@/lib/utils';

type Status = 'ok' | 'warn' | 'fail' | 'manual';
interface Check { id: string; group: 'required' | 'connections' | 'data'; label: string; status: Status; detail: string; fix?: string }
interface Data { checks: Check[]; blocking: number; ready: boolean; demo?: boolean }

const ICON = {
  ok: <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />,
  warn: <AlertTriangle className="size-4 text-warning" />,
  fail: <XCircle className="size-4 text-destructive" />,
  manual: <ClipboardList className="size-4 text-muted-foreground" />,
};
const GROUPS: [Check['group'], string][] = [['required', 'Required'], ['connections', 'Connections'], ['data', 'The books']];

export function GoLivePanel() {
  const state = useApi<Data>(() => api.get('/api/settings/golive'), []);
  const d = state.data;
  return (
    <Card className="space-y-4 p-5" data-slot="golive">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Go-live check</h3>
          <p className="text-xs text-muted-foreground">Whether this server is set up to keep real books, and what to do about anything missing.</p>
        </div>
        <Button size="sm" variant="outline" className="gap-1.5" disabled={state.refreshing} onClick={() => void state.refetch()}>
          <RefreshCw className={cn('size-3.5', state.refreshing && 'animate-spin')} /> Check again
        </Button>
      </div>
      {state.error && <p className="text-sm text-destructive">{state.error}</p>}
      {d?.demo && (
        <p className="rounded-[3px] border px-3 py-2 text-sm text-muted-foreground" data-slot="golive-demo">
          The go-live check looks at the server your own books run on. It is not run from the demo book, which anyone may open.
        </p>
      )}
      {d && !d.demo && (
        <>
          <p className={cn('rounded-[3px] border px-3 py-2 text-sm font-medium', d.ready ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-destructive/40 bg-destructive/10')} data-slot="golive-verdict">
            {d.ready ? 'Ready to keep real books. Work through the warnings before relying on them.' : `Not ready: ${d.blocking} required item${d.blocking === 1 ? '' : 's'} to fix.`}
          </p>
          {GROUPS.map(([g, title]) => {
            const mine = d.checks.filter((c) => c.group === g);
            if (!mine.length) return null;
            return (
              <div key={g} className="space-y-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{title}</p>
                <ul className="divide-y rounded-md border">
                  {mine.map((c) => (
                    <li key={c.id} className="flex gap-3 px-3 py-2 text-sm" data-slot={`golive-${c.id}`} data-status={c.status}>
                      <span className="mt-0.5 shrink-0">{ICON[c.status]}</span>
                      <span className="min-w-0">
                        <span className="font-medium">{c.label}</span>
                        <span className="block text-muted-foreground">{c.detail}</span>
                        {c.status !== 'ok' && c.fix && <span className="mt-0.5 block text-xs">{c.fix}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </>
      )}
    </Card>
  );
}
