'use client';

// Attach files kept in Documents to a record: pick the kind of record, find it
// by its number or the party's name, and the files move there.

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

/** Find the record by number or name, then attach the files to it. */
export function AttachDialog({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: (label: string) => void }) {
  const types = useApi<{ types: { type: string; label: string }[] }>(() => api.get('/api/documents/targets'), []);
  const [type, setType] = useState('bill');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const results = useApi<{ results: { id: string; label: string; sub: string }[] }>(() => api.get('/api/documents/targets', { type, q }), [type, q]);
  const attach = async (r: { id: string; label: string }) => {
    setBusy(true);
    try {
      await api.patch('/api/documents/files', { action: 'attach', fileIds: ids, targetType: type, targetId: r.id });
      onDone(r.label);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not attach');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Attach {ids.length === 1 ? 'the file' : `${ids.length} files`} to a transaction</DialogTitle>
          <DialogDescription>Pick the kind of record, then find it by its number or the party&apos;s name.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-1.5">
          {(types.data?.types ?? []).map((t) => (
            <Button key={t.type} size="sm" variant={type === t.type ? 'default' : 'outline'} className="h-7 text-xs" onClick={() => setType(t.type)}>{t.label}</Button>
          ))}
        </div>
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Number, or the customer's or vendor's name" />
        <div className="max-h-72 divide-y overflow-y-auto rounded-md border thin-scroll">
          {results.loading && <p className="px-3 py-3 text-sm text-muted-foreground">Searching…</p>}
          {!results.loading && (results.data?.results ?? []).length === 0 && <p className="px-3 py-3 text-sm text-muted-foreground">Nothing found.</p>}
          {(results.data?.results ?? []).map((r) => (
            <button key={r.id} type="button" disabled={busy} onClick={() => void attach(r)} className="block w-full px-3 py-2 text-left hover:bg-accent">
              <p className="text-sm font-medium">{r.label}</p>
              <p className="text-xs text-muted-foreground">{r.sub}</p>
            </button>
          ))}
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
