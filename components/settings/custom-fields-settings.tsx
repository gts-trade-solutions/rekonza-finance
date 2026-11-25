'use client';

// Settings → Custom fields: the extra boxes on customers, items and documents.
// A field with values cannot change type, and is switched off rather than
// deleted, so what was recorded stays readable.

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Combobox } from '@/components/ui/combobox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/shared/form-bits';
import { AsyncPage } from '@/components/shared/async-state';
import { api, customFields, type CustomFieldDefinition, type CustomFieldEntity } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { RowActions, reasonQuery, useConfirmDelete } from '@/components/shared/row-actions';

const ENTITIES: { value: CustomFieldEntity; label: string }[] = [
  { value: 'contact', label: 'Customers & vendors' }, { value: 'item', label: 'Items' }, { value: 'invoice', label: 'Invoices' },
  { value: 'estimate', label: 'Estimates' }, { value: 'sales_order', label: 'Sales orders' }, { value: 'bill', label: 'Bills' },
  { value: 'purchase_order', label: 'Purchase orders' }, { value: 'expense', label: 'Expenses' }, { value: 'project', label: 'Projects' },
];
const TYPES = [
  { value: 'text', label: 'Text' }, { value: 'number', label: 'Number' }, { value: 'date', label: 'Date' },
  { value: 'select', label: 'Dropdown' }, { value: 'checkbox', label: 'Tick box' },
];
const BLANK = { id: null as string | null, entity: 'invoice' as CustomFieldEntity, label: '', type: 'text' as CustomFieldDefinition['type'], options: '', required: false, showOnPdf: false, isActive: true };

export function CustomFieldsSettings({ canEdit }: { canEdit: boolean }) {
  const state = useApi(() => customFields.list(), []);
  const save = useApiAction(customFields.save);
  const [f, setF] = useState<typeof BLANK | null>(null);
  const del = useConfirmDelete();
  const open = (x: CustomFieldDefinition) => setF({ id: x.id, entity: x.entity, label: x.label, type: x.type, options: x.options.join(', '), required: x.required, showOnPdf: x.showOnPdf, isActive: x.isActive });
  const remove = (x: CustomFieldDefinition) => del.ask({
    title: `Delete the field ${x.label}?`,
    description: 'Only a field no record holds a value in can be deleted. One that has values is marked as inactive instead: it leaves the forms, and what was recorded stays readable.',
    run: (reason) => api.delete(`/api/custom-fields?id=${x.id}${reasonQuery(reason, false)}`),
    done: `${x.label} deleted`, onDone: () => state.refetch(),
    instead: x.isActive ? {
      label: 'Mark as inactive instead',
      run: () => customFields.save({ id: x.id, entity: x.entity, label: x.label, type: x.type, required: x.required, showOnPdf: x.showOnPdf, isActive: false, options: x.type === 'select' ? x.options : undefined }),
    } : undefined,
  });

  const submit = async () => {
    if (!f) return;
    const done = await save.run({
      id: f.id, entity: f.entity, label: f.label, type: f.type, required: f.required, showOnPdf: f.showOnPdf, isActive: f.isActive,
      options: f.type === 'select' ? f.options.split(',').map((o) => o.trim()).filter(Boolean) : undefined,
    });
    if (!done) { toast.error(save.error ?? 'Not saved'); return; }
    toast.success('Field saved');
    setF(null);
    state.refetch();
  };

  return (
    <div className="space-y-4" data-slot="custom-fields-settings">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Extra details you keep on customers, items and documents. Ticked to print, they appear on the PDF.</p>
        {canEdit && <Button size="sm" onClick={() => setF({ ...BLANK })} className="gap-1.5"><Plus className="size-4" /> New field</Button>}
      </div>
      <AsyncPage state={state}>
        {(d) => (
          <div className="grid gap-3 md:grid-cols-2">
            {ENTITIES.map((e) => {
              const list = d.fields.filter((x) => x.entity === e.value);
              if (!list.length) return null;
              return (
                <Card key={e.value} className="p-4">
                  <p className="mb-2 text-sm font-semibold">{e.label}</p>
                  {list.map((x) => (
                    <div key={x.id} className="flex w-full flex-wrap items-center justify-between gap-2 border-t py-2 text-left text-sm" data-slot="custom-field">
                      <span className={x.isActive ? '' : 'text-muted-foreground line-through'}>{x.label}</span>
                      <span className="flex flex-wrap items-center gap-1">
                        <Badge variant="outline" className="text-[10px]">{TYPES.find((t) => t.value === x.type)?.label}</Badge>
                        {x.required && <Badge variant="secondary" className="text-[10px]">Required</Badge>}
                        {x.showOnPdf && <Badge variant="secondary" className="text-[10px]">On PDF</Badge>}
                        {canEdit && <RowActions onEdit={() => open(x)} onDelete={() => remove(x)} />}
                      </span>
                    </div>
                  ))}
                </Card>
              );
            })}
            {!d.fields.length && <p className="text-sm text-muted-foreground">No custom fields yet.</p>}
          </div>
        )}
      </AsyncPage>

      {del.dialog}
      <Dialog open={!!f} onOpenChange={(o) => !o && setF(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{f?.id ? 'Edit field' : 'New field'}</DialogTitle>
            <DialogDescription>Once a field has values, its type is fixed. Switch it off instead of removing it.</DialogDescription>
          </DialogHeader>
          {f && (
            <div className="grid gap-4">
              <Field label="On">
                <Combobox options={ENTITIES} value={f.entity} onChange={(v) => setF({ ...f, entity: v as CustomFieldEntity })} showAvatar={false} disabled={!!f.id} />
              </Field>
              <Field label="Label" required><Input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Vehicle number" /></Field>
              <Field label="Type">
                <Combobox options={TYPES} value={f.type} onChange={(v) => setF({ ...f, type: v as CustomFieldDefinition['type'] })} showAvatar={false} />
              </Field>
              {f.type === 'select' && (
                <Field label="Choices" hint="Separated by commas"><Input value={f.options} onChange={(e) => setF({ ...f, options: e.target.value })} placeholder="North, South, East, West" /></Field>
              )}
              <label className="flex items-center justify-between text-sm">Required <Switch checked={f.required} onCheckedChange={(v) => setF({ ...f, required: v })} /></label>
              <label className="flex items-center justify-between text-sm">Print on the PDF <Switch checked={f.showOnPdf} onCheckedChange={(v) => setF({ ...f, showOnPdf: v })} /></label>
              {f.id && <label className="flex items-center justify-between text-sm">In use <Switch checked={f.isActive} onCheckedChange={(v) => setF({ ...f, isActive: v })} /></label>}
            </div>
          )}
          {save.error && <p className="text-sm text-destructive">{save.error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setF(null)}>Cancel</Button>
            <Button onClick={submit} disabled={save.busy}>{save.busy ? 'Saving…' : 'Save field'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
