'use client';

// Entries made without a connection (lib/offline/outbox.ts): sent when the
// connection is back, in the order they were made, with a note in the corner
// while any are waiting. One the server refused stays, with its reason, until
// someone discards it — after making it again properly, if it should exist.

import { useCallback, useEffect, useState } from 'react';
import { CloudOff, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { flushOutbox, listOutbox, removeItem, setOutboxOwner, type OutboxItem } from '@/lib/offline/outbox';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';

export function OfflineSync() {
  const userId = useAppStore((s) => s.session?.userId);
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setItems(await listOutbox()); } catch { /* storage unavailable: nothing kept */ }
  }, []);

  const sync = useCallback(async () => {
    if (!navigator.onLine) return;
    setBusy(true);
    try {
      const { sent, failed } = await flushOutbox();
      if (sent.length) toast.success(`${sent.length} entr${sent.length === 1 ? 'y' : 'ies'} made offline sent`, { description: sent.map((s) => s.label).join(', ') });
      if (failed.length) toast.error(`${failed.length} entr${failed.length === 1 ? 'y was' : 'ies were'} refused`, { description: failed.map((f) => `${f.label}: ${f.error}`).join(' · ') });
    } catch { /* tried again later */ } finally {
      setBusy(false);
      await load();
    }
  }, [load]);

  useEffect(() => {
    setOutboxOwner(userId ? String(userId) : null);
    void load().then(sync);
    const changed = () => void load();
    window.addEventListener('rekonza-outbox', changed);
    window.addEventListener('online', sync);
    const timer = window.setInterval(() => void sync(), 60_000);
    return () => { window.removeEventListener('rekonza-outbox', changed); window.removeEventListener('online', sync); window.clearInterval(timer); setOutboxOwner(null); };
  }, [load, sync, userId]);

  if (!items.length) return null;
  const waiting = items.filter((i) => i.status === 'waiting').length;
  const failed = items.length - waiting;
  const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <div className="fixed bottom-4 left-4 z-50 no-print">
      {open && (
        <div className="mb-2 w-80 rounded-lg border bg-popover p-3 text-sm shadow-lg">
          <p className="mb-2 font-medium">Made on this device, not yet sent</p>
          <ul className="max-h-64 space-y-2 overflow-auto thin-scroll">
            {items.map((i) => (
              <li key={i.key} className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className={cn('text-sm', i.status === 'failed' && 'text-destructive')}>{i.label} · {when(i.createdAt)}</p>
                  {i.error && <p className="text-xs text-muted-foreground">{i.error}</p>}
                </div>
                <button type="button" aria-label="Discard" title="Discard this copy"
                  onClick={() => { if (window.confirm(`Discard this ${i.label.toLowerCase()}? It was never saved.`)) void removeItem(i.key); }}
                  className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
          <Button size="sm" variant="outline" className="mt-2 w-full gap-1.5" disabled={busy} onClick={() => void sync()}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Send now
          </Button>
        </div>
      )}
      <button type="button" onClick={() => setOpen(!open)}
        className={cn('flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium shadow-sm',
          failed ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-amber-500/40 bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300')}>
        <CloudOff className="size-3.5" />
        {waiting ? `${waiting} waiting to be sent` : ''}{waiting && failed ? ' · ' : ''}{failed ? `${failed} refused` : ''}
      </button>
    </div>
  );
}
