'use client';

// A document's reporting tags (Settings → Reporting tags): one value of each
// tag, set in place. Shows nothing when the business has no tags.

import { useEffect, useState } from 'react';
import { Tags } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

interface Tag { id: string; name: string; isActive: boolean; options: { id: string; value: string; isActive: boolean }[] }
export type TagEntity = 'invoice' | 'bill' | 'expense' | 'journal_entry';

export function TagsPanel({ entity, id, canEdit }: { entity: TagEntity; id: string; canEdit: boolean }) {
  const state = useApi(() => api.get<{ tags: Tag[]; values: Record<string, string> }>('/api/reporting-tags', { entity, id }), [entity, id]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(state.data?.values ?? {}); }, [state.data]);
  const tags = (state.data?.tags ?? []).filter((t) => t.isActive);
  if (!tags.length) return null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.data?.values ?? {});

  const save = async () => {
    setBusy(true);
    try {
      await api.post('/api/reporting-tags', { action: 'assign', entity, id, values: Object.fromEntries(tags.map((t) => [t.id, draft[t.id] || null])) });
      toast.success('Tags saved');
      state.refetch();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-3 p-5" data-slot="reporting-tags">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold"><Tags className="size-4 text-muted-foreground" /> Reporting tags</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {tags.map((t) => (
          <label key={t.id} className="grid gap-1 text-xs text-muted-foreground">
            {t.name}
            <select value={draft[t.id] ?? ''} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, [t.id]: e.target.value })} className="h-8 rounded-md border bg-background px-2 text-sm text-foreground">
              <option value="">—</option>
              {t.options.filter((o) => o.isActive || o.id === draft[t.id]).map((o) => <option key={o.id} value={o.id}>{o.value}</option>)}
            </select>
          </label>
        ))}
      </div>
      {canEdit && dirty && <div className="flex justify-end"><Button size="sm" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save tags'}</Button></div>}
    </Card>
  );
}
