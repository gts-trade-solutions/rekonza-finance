'use client';

// System health: every error the server did not expect (lib/server/error-log.ts),
// how often and where, and what was found and done about it; and background
// jobs that gave up.

import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { AsyncPage } from '@/components/shared/async-state';
import { api, ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

interface ErrorRow {
  id: string; ref: string; method: string | null; path: string | null; name: string | null; message: string | null; stack: string | null;
  occurrences: number; firstSeen: string; lastSeen: string; status: 'open' | 'investigating' | 'resolved';
  rootCause: string | null; resolution: string | null; resolvedBy: string | null; resolvedAt: string | null;
}
interface Response { errors: ErrorRow[]; failedJobs: { id: string; kind: string; attempts: number; error: string | null; at: string }[] }

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const TONE = { open: 'border-red-500/40 text-red-700 dark:text-red-400', investigating: 'border-amber-500/40 text-amber-700 dark:text-amber-400', resolved: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400' };

export function HealthPanel() {
  const state = useApi<Response>(() => api.get('/api/settings/errors'), []);
  const [open, setOpen] = useState<ErrorRow | null>(null);
  const [cause, setCause] = useState('');
  const [fix, setFix] = useState('');

  const update = async (row: ErrorRow, status: ErrorRow['status']) => {
    try {
      await api.patch('/api/settings/errors', { id: row.id, status, rootCause: cause || row.rootCause, resolution: fix || row.resolution });
      toast.success(status === 'resolved' ? 'Marked resolved' : 'Updated');
      setOpen(null);
      await state.refetch();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof ApiError ? e.message : String(e) });
    }
  };

  return (
    <AsyncPage state={state}>
      {(d) => (
        <div className="space-y-4">
          <Card className="p-4">
            <h3 className="font-semibold">Errors</h3>
            <p className="text-sm text-muted-foreground">
              Every error the software did not expect, with when, where and how often. Whoever met it was shown the reference.
              Close each with its cause and what was done.
            </p>
          </Card>
          {d.errors.length === 0 ? (
            <Card className="flex items-center gap-2 border-emerald-500/40 bg-emerald-500/5 p-4 text-sm">
              <CheckCircle2 className="size-4 text-emerald-600" /> No unexpected errors recorded.
            </Card>
          ) : (
            <div className="space-y-2">
              {d.errors.map((e) => (
                <Card key={e.id} className="space-y-1 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={TONE[e.status]}>{e.status}</Badge>
                    <span className="font-mono text-xs">{e.ref}</span>
                    <span className="text-xs text-muted-foreground">{e.method} {e.path}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{e.occurrences}× · last {when(e.lastSeen)}</span>
                  </div>
                  <p className="text-sm">{e.name}: {e.message}</p>
                  {e.rootCause && <p className="text-xs"><span className="font-medium">Cause:</span> {e.rootCause}</p>}
                  {e.resolution && <p className="text-xs"><span className="font-medium">Fix:</span> {e.resolution}{e.resolvedBy ? ` — ${e.resolvedBy}` : ''}</p>}
                  <Button size="sm" variant="outline" onClick={() => { setOpen(e); setCause(e.rootCause ?? ''); setFix(e.resolution ?? ''); }}>Work on it</Button>
                </Card>
              ))}
            </div>
          )}

          <Card className="p-4">
            <h3 className="font-semibold">Background jobs that gave up</h3>
            {d.failedJobs.length === 0 ? (
              <p className="text-sm text-muted-foreground">None.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {d.failedJobs.map((j) => (
                  <li key={j.id}><span className="font-mono text-xs">{j.kind}</span> after {j.attempts} attempt{j.attempts === 1 ? '' : 's'}, {when(j.at)}: <span className="text-muted-foreground">{j.error}</span></li>
                ))}
              </ul>
            )}
          </Card>

          <Dialog open={!!open} onOpenChange={(o) => { if (!o) setOpen(null); }}>
            <DialogContent className="max-w-2xl">
              <DialogHeader><DialogTitle>Error {open?.ref}</DialogTitle></DialogHeader>
              {open && (
                <div className="space-y-3">
                  <p className="text-sm">{open.name}: {open.message}</p>
                  <pre className="max-h-48 overflow-auto rounded bg-muted p-2 text-[11px]">{open.stack}</pre>
                  <div className="space-y-1.5"><Label htmlFor="err-cause">What caused it</Label>
                    <Textarea id="err-cause" rows={2} value={cause} onChange={(e) => setCause(e.target.value)} /></div>
                  <div className="space-y-1.5"><Label htmlFor="err-fix">What was done</Label>
                    <Textarea id="err-fix" rows={2} value={fix} onChange={(e) => setFix(e.target.value)} /></div>
                </div>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => open && update(open, 'investigating')}>Being looked at</Button>
                <Button onClick={() => open && update(open, 'resolved')} disabled={!cause.trim() || !fix.trim()}>Resolved</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      )}
    </AsyncPage>
  );
}
