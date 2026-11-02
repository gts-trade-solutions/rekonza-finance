'use client';

// Settings → Reporting tags: the dimensions the business reports by beyond
// accounts and cost centres. A value removed is switched off, not deleted, so
// documents already tagged with it keep their tag.

import { useState } from 'react';
import { Plus, Tags } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/shared/form-bits';
import { AsyncPage } from '@/components/shared/async-state';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

interface Tag { id: string; name: string; isActive: boolean; options: { id: string; value: string; isActive: boolean }[] }

export function ReportingTagsSettings({ canEdit }: { canEdit: boolean }) {
  const state = useApi(() => api.get<{ tags: Tag[] }>('/api/reporting-tags'), []);
  const [f, setF] = useState<{ id: string | null; name: string; values: string; isActive: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!f) return;
    setBusy(true);
    try {
      await api.post('/api/reporting-tags', { action: 'save', id: f.id, name: f.name, values: f.values.split(/[,\n]/).map((v) => v.trim()).filter(Boolean), isActive: f.isActive });
      toast.success('Tag saved');
      setF(null);
      state.refetch();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-slot="reporting-tags-settings">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Region, channel, product line: put a value on invoices, bills, expenses and journals, and cut the profit and loss by it (Reports → Profit by Reporting Tag).</p>
        {canEdit && <Button size="sm" onClick={() => setF({ id: null, name: '', values: '', isActive: true })} className="gap-1.5"><Plus className="size-4" /> New tag</Button>}
      </div>
      <AsyncPage state={state}>
        {(d) => (
          <div className="grid gap-3 md:grid-cols-2">
            {d.tags.map((t) => (
              <Card key={t.id} className="space-y-2 p-4">
                <button type="button" disabled={!canEdit} className="flex w-full items-center justify-between text-left"
                  onClick={() => setF({ id: t.id, name: t.name, values: t.options.filter((o) => o.isActive).map((o) => o.value).join(', '), isActive: t.isActive })}>
                  <span className="flex items-center gap-1.5 font-medium"><Tags className="size-4 text-muted-foreground" />{t.name}</span>
                  {!t.isActive && <Badge variant="outline" className="text-[10px]">Off</Badge>}
                </button>
                <div className="flex flex-wrap gap-1">{t.options.filter((o) => o.isActive).map((o) => <Badge key={o.id} variant="secondary" className="text-[10px]">{o.value}</Badge>)}</div>
              </Card>
            ))}
            {!d.tags.length && <p className="text-sm text-muted-foreground">No reporting tags yet.</p>}
          </div>
        )}
      </AsyncPage>
      <Dialog open={!!f} onOpenChange={(o) => !o && setF(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{f?.id ? 'Edit tag' : 'New reporting tag'}</DialogTitle><DialogDescription>A value removed here is switched off; documents keep it.</DialogDescription></DialogHeader>
          {f && (
            <div className="grid gap-4">
              <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Region" /></Field>
              <Field label="Values" hint="Separated by commas"><Input value={f.values} onChange={(e) => setF({ ...f, values: e.target.value })} placeholder="North, South, East, West" /></Field>
              {f.id && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> In use</label>}
            </div>
          )}
          <DialogFooter><Button variant="outline" onClick={() => setF(null)}>Cancel</Button><Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save tag'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
