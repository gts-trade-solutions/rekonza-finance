'use client';

// A record's custom fields (Settings → Custom fields), shown and edited in
// place. Shows nothing when the business has added no fields for this kind of
// record, so a screen does not carry an empty box.

import { useEffect, useState } from 'react';
import { Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { customFields, type CustomFieldEntity, type CustomFieldValue } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';

const shown = (v: CustomFieldValue) =>
  v.value == null || v.value === '' ? '—'
    : v.type === 'checkbox' ? (v.value === 'true' ? 'Yes' : 'No')
    : v.type === 'date' ? new Date(v.value).toLocaleDateString('en-IN')
    : v.value;

export function CustomFieldsPanel({ entity, id, canEdit, className }: { entity: CustomFieldEntity; id: string; canEdit: boolean; className?: string }) {
  const state = useApi(() => customFields.values(entity, id), [entity, id]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string | null>>({});
  const save = useApiAction(customFields.setValues);
  useEffect(() => {
    setDraft(Object.fromEntries((state.data?.values ?? []).map((v) => [v.key, v.value])));
  }, [state.data]);

  const values = state.data?.values ?? [];
  if (!values.length) return null;

  const submit = async () => {
    if (!(await save.run(entity, id, draft))) { toast.error(save.error ?? 'Not saved'); return; }
    toast.success('Saved');
    setEditing(false);
    state.refetch();
  };

  return (
    <Card className={className ?? 'space-y-3 p-5'} data-slot="custom-fields">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">More details</h3>
        {canEdit && !editing && <Button size="icon-sm" variant="ghost" aria-label="Edit details" onClick={() => setEditing(true)}><Pencil className="size-3.5" /></Button>}
      </div>
      <div className="space-y-2 text-sm">
        {values.map((v) => (
          <div key={v.fieldId}>
            <p className="text-xs text-muted-foreground">{v.label}{v.required && editing ? ' *' : ''}</p>
            {!editing ? <p className="mt-0.5">{shown(v)}</p>
              : v.type === 'checkbox' ? <Switch checked={draft[v.key] === 'true'} onCheckedChange={(c) => setDraft({ ...draft, [v.key]: c ? 'true' : 'false' })} />
              : v.type === 'select' ? (
                <select value={draft[v.key] ?? ''} onChange={(e) => setDraft({ ...draft, [v.key]: e.target.value || null })} className="mt-0.5 h-8 w-full rounded-md border bg-background px-2 text-sm">
                  <option value="">—</option>
                  {v.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              )
              : <Input className="mt-0.5 h-8" type={v.type === 'number' ? 'number' : v.type === 'date' ? 'date' : 'text'} value={draft[v.key] ?? ''}
                  onChange={(e) => setDraft({ ...draft, [v.key]: e.target.value })} />}
          </div>
        ))}
      </div>
      {editing && (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => { setEditing(false); state.refetch(); }}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={save.busy}>{save.busy ? 'Saving…' : 'Save'}</Button>
        </div>
      )}
      {save.error && <p className="text-xs text-destructive">{save.error}</p>}
    </Card>
  );
}
