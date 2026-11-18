'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Zoho's advanced search, opened from the magnifier at the end of a list's
// header row: "Search [module] Filter [view]" across the top, the module's
// fields in two columns (label to the left of each box), Search and Cancel.
// Every field filled must match; the list then shows only those rows.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

export interface AdvancedField<T> {
  key: string;
  label: string;
  /** A choice of values ("Status": All, Active, Inactive); left out, a text box. */
  options?: { value: string; label: string }[];
  /** Whether a row matches what was typed or chosen. */
  match: (row: T, value: string) => boolean;
}

export interface AdvancedSearchConfig<T> {
  /** Zoho's "Search" box: the module, "Customers" or "Items". */
  module: string;
  fields: AdvancedField<T>[];
}

/** Text a field holds, matched without regard to case. */
export const contains = (v: unknown, q: string) => String(v ?? '').toLowerCase().includes(q.trim().toLowerCase());

const select = 'h-[34px] w-full rounded-[var(--radius-button)] border border-input bg-background px-2 text-[13px] outline-none focus:border-primary';

export function AdvancedSearchDialog<T>({ config, view, value, open, onOpenChange, onSearch }: {
  config: AdvancedSearchConfig<T>;
  /** The list's view, shown as Zoho's "Filter". */
  view: string;
  value: Record<string, string>;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSearch: (criteria: Record<string, string>) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { if (open) setDraft(value); }, [open, value]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl gap-0 p-0 sm:max-w-4xl" showCloseButton={false} data-slot="advanced-search">
        <DialogTitle className="sr-only">Search {config.module}</DialogTitle>
        <div className="flex items-center gap-4 rounded-t-[var(--radius-card)] bg-[#f9f9fb] px-6 py-3 dark:bg-muted/40">
          <label className="flex flex-1 items-center gap-3 text-[13px]">
            <span className="w-24 text-right">Search</span>
            <select className={select} value={config.module} disabled aria-label="Search in"><option>{config.module}</option></select>
          </label>
          <label className="flex flex-1 items-center gap-3 text-[13px]">
            <span className="w-16 text-right">Filter</span>
            <select className={select} value={view} disabled aria-label="Filter"><option>{view}</option></select>
          </label>
          <button type="button" aria-label="Close" onClick={() => onOpenChange(false)} className="text-foreground hover:opacity-70"><X className="size-4" strokeWidth={2.5} /></button>
        </div>
        <form
          className="space-y-0"
          onSubmit={(e) => { e.preventDefault(); onSearch(Object.fromEntries(Object.entries(draft).filter(([, v]) => v.trim()))); onOpenChange(false); }}
        >
          <div className="grid grid-cols-1 gap-x-8 gap-y-3 px-6 py-6 md:grid-cols-2">
            {config.fields.map((f) => (
              <label key={f.key} className="flex items-center gap-3 text-[13px]">
                <span className="w-32 shrink-0 text-right">{f.label}</span>
                {f.options ? (
                  <select className={select} value={draft[f.key] ?? ''} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} aria-label={f.label}>
                    {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : (
                  <Input value={draft[f.key] ?? ''} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} aria-label={f.label} />
                )}
              </label>
            ))}
          </div>
          <div className="flex justify-center gap-2 border-t px-6 py-4">
            <Button type="submit" data-slot="advanced-search-go">Search</Button>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
