'use client';

// Saved views on a list: the filters in force kept under a name, for the
// person who saved them or shared with the company, and put back in one click.

import { useState } from 'react';
import { Bookmark, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

export type SavedList = 'invoices' | 'bills' | 'expenses' | 'payments-received' | 'payments-made' | 'contacts';
interface View { id: string; name: string; shared: boolean; mine: boolean; filters: Record<string, unknown> }

export function SavedViews<F extends Record<string, unknown>>({ list, current, onApply }: { list: SavedList; current: F; onApply: (f: F) => void }) {
  const state = useApi(() => api.get<{ views: View[] }>('/api/saved-views', { list }), [list]);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [open, setOpen] = useState(false);

  const save = async () => {
    if (!name.trim()) return;
    try {
      await api.post('/api/saved-views', { list, name: name.trim(), filters: current, shared });
      toast.success(`View "${name.trim()}" saved`);
      setName('');
      state.refetch();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    }
  };
  const remove = async (v: View) => {
    try { await api.delete(`/api/saved-views?id=${v.id}`); state.refetch(); } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="inline-flex h-8 items-center gap-1.5 rounded-[3px] border px-3 text-sm transition-colors hover:bg-accent" data-slot="saved-views">
        <Bookmark className="size-3.5" /> Views{state.data?.views.length ? ` (${state.data.views.length})` : ''}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3">
        <div className="space-y-1">
          {(state.data?.views ?? []).map((v) => (
            <div key={v.id} className="flex items-center justify-between gap-2">
              <button type="button" className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-sm hover:bg-accent" onClick={() => { onApply(v.filters as F); setOpen(false); toast.info(`Showing "${v.name}"`); }}>
                {v.name}{v.shared ? <span className="text-xs text-muted-foreground"> · shared</span> : null}
              </button>
              {v.mine && <Button size="icon-sm" variant="ghost" aria-label={`Delete ${v.name}`} onClick={() => remove(v)}><Trash2 className="size-3.5" /></Button>}
            </div>
          ))}
          {!state.data?.views.length && <p className="text-xs text-muted-foreground">No saved views yet. Set the filters, then save them here.</p>}
        </div>
        <div className="space-y-2 border-t pt-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name these filters" className="h-8 text-sm" />
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with everyone</label>
          <Button size="sm" className="w-full" onClick={save} disabled={!name.trim()}>Save current filters</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
