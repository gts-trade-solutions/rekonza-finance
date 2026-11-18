'use client';

// Zoho's "New View": name it, define the criteria (each a field, a comparator
// and a value, all of them to be met or any one), choose the columns it shows,
// and who sees it (only me, or everyone). Saved through /api/saved-views.

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { api } from '@/lib/api/client';
import { OPS, takesValue, type CustomView, type ViewCriterion, type ViewField, type ViewOp } from '@/lib/custom-views';

const selectCls = 'h-[34px] rounded-[var(--radius-button)] border border-input bg-background px-2 text-[13px] outline-none focus:border-primary';

export function CustomViewDialog<T>({ open, onOpenChange, list, fields, columns, onSaved }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  list: string;
  fields: ViewField<T>[];
  /** The list's columns, to choose which the view shows. */
  columns: { key: string; header: string }[];
  onSaved: (id: string) => void;
}) {
  const blank = (): ViewCriterion => ({ field: fields[0]?.key ?? '', op: OPS[fields[0]?.type ?? 'text'][0].op, value: '' });
  const [name, setName] = useState('');
  const [favourite, setFavourite] = useState(false);
  const [match, setMatch] = useState<'all' | 'any'>('all');
  const [criteria, setCriteria] = useState<ViewCriterion[]>([blank()]);
  const [shown, setShown] = useState<string[]>(columns.map((c) => c.key));
  const [everyone, setEveryone] = useState(false);
  const [busy, setBusy] = useState(false);
  const fieldOf = (key: string) => fields.find((f) => f.key === key) ?? fields[0];
  const setRow = (i: number, patch: Partial<ViewCriterion>) => setCriteria((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const save = async () => {
    if (!name.trim()) { toast.error('Name the view.'); return; }
    const used = criteria.filter((c) => c.field && (!takesValue(c.op) || (c.value ?? '').trim()));
    if (!used.length) { toast.error('Add at least one criterion, with its value.'); return; }
    if (!shown.length) { toast.error('Choose at least one column.'); return; }
    const filters: CustomView & { kind: 'custom'; favourite: boolean } = { kind: 'custom', match, criteria: used, columns: shown, favourite };
    setBusy(true);
    try {
      const r = await api.post<{ id: string }>('/api/saved-views', { list, name: name.trim(), filters, shared: everyone });
      toast.success(`View "${name.trim()}" saved`);
      onSaved(r.id);
      onOpenChange(false);
      setName(''); setCriteria([blank()]); setFavourite(false); setEveryone(false); setMatch('all');
    } catch (e) {
      toast.error('The view was not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl" data-slot="new-view">
        <DialogHeader>
          <DialogTitle>New Custom View</DialogTitle>
          <DialogDescription>Rows that meet the criteria, with the columns you choose.</DialogDescription>
        </DialogHeader>
        <div className="space-y-5 text-[13px]">
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex min-w-0 flex-1 items-center gap-3">
              <span className="w-20 shrink-0 text-required">Name*</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label="View name" data-slot="view-name" />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" className="size-3.5 accent-primary" checked={favourite} onChange={(e) => setFavourite(e.target.checked)} />
              Mark as Favorite
            </label>
          </div>

          <section className="space-y-2">
            <h4 className="text-[14px] font-medium">Define the criteria ( if any )</h4>
            {criteria.map((c, i) => {
              const f = fieldOf(c.field);
              const ops = OPS[f?.type ?? 'text'];
              return (
                <div key={i} className="flex flex-wrap items-center gap-2" data-slot="view-criterion">
                  <span className="w-8 text-center text-muted-foreground tabular">{i + 1}</span>
                  <select value={c.field} aria-label="Field" className={selectCls}
                    onChange={(e) => { const nf = fieldOf(e.target.value); setRow(i, { field: e.target.value, op: OPS[nf.type][0].op, value: '' }); }}>
                    {fields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                  </select>
                  <select value={c.op} aria-label="Comparator" className={selectCls} onChange={(e) => setRow(i, { op: e.target.value as ViewOp })}>
                    {ops.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
                  </select>
                  {takesValue(c.op) && (f?.type === 'choice' ? (
                    <select value={c.value ?? ''} aria-label="Value" className={selectCls} onChange={(e) => setRow(i, { value: e.target.value })}>
                      <option value="">Choose…</option>
                      {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <Input value={c.value ?? ''} onChange={(e) => setRow(i, { value: e.target.value })} aria-label="Value"
                      type={f?.type === 'number' ? 'number' : f?.type === 'date' ? 'date' : 'text'} className="h-[34px] w-44" />
                  ))}
                  <button type="button" aria-label="Remove this criterion" onClick={() => setCriteria((cs) => (cs.length > 1 ? cs.filter((_, j) => j !== i) : cs))}
                    className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-muted"><Trash2 className="size-3.5" /></button>
                </div>
              );
            })}
            <div className="flex flex-wrap items-center gap-4 pl-10">
              <button type="button" onClick={() => setCriteria((cs) => [...cs, blank()])} className="inline-flex items-center gap-1 text-link hover:underline" data-slot="add-criterion">
                <Plus className="size-3.5" /> Add Criterion
              </button>
              {criteria.length > 1 && (
                <label className="flex items-center gap-2">
                  Match
                  <select value={match} onChange={(e) => setMatch(e.target.value as 'all' | 'any')} className={selectCls} aria-label="Match">
                    <option value="all">all of them (AND)</option>
                    <option value="any">any of them (OR)</option>
                  </select>
                </label>
              )}
            </div>
          </section>

          <section className="space-y-2">
            <h4 className="text-[14px] font-medium">Columns Preference</h4>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {columns.map((c, i) => (
                <label key={c.key} className="flex items-center gap-2">
                  <input type="checkbox" className="size-3.5 accent-primary" disabled={i === 0} checked={shown.includes(c.key)}
                    onChange={() => setShown((s) => (s.includes(c.key) ? s.filter((k) => k !== c.key) : columns.map((x) => x.key).filter((k) => s.includes(k) || k === c.key)))} />
                  <span className="capitalize">{c.header.toLowerCase()}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <h4 className="text-[14px] font-medium">Visibility Preference</h4>
            <div className="flex gap-6">
              <label className="flex items-center gap-2"><input type="radio" name="visibility" className="size-3.5 accent-primary" checked={!everyone} onChange={() => setEveryone(false)} /> Only Me</label>
              <label className="flex items-center gap-2"><input type="radio" name="visibility" className="size-3.5 accent-primary" checked={everyone} onChange={() => setEveryone(true)} /> Everyone</label>
            </div>
          </section>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy} data-slot="save-view">{busy ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
