'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Zoho's two export dialogs, behind a list's ⋯ → Export:
//   "Export Customers" (or Items): the module (a customer's contact persons
//   and addresses are modules of their own), all records or a specific period,
//   CSV / XLS / XLSX, whether to include personal data, a file password, and
//   the row limit.
//   "Export Current View": the view as it stands, its visible columns only, in
//   the format chosen, with a password if wanted.
// A password puts the file inside a password-protected zip.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { downloadExport, type ExportFormat, type Sheet } from '@/lib/xlsx';
import { today } from '@/lib/selectors';

const FORMATS: [ExportFormat, string][] = [
  ['csv', 'CSV (Comma Separated Value)'],
  ['xls', 'XLS (Microsoft Excel 1997-2004 Compatible)'],
  ['xlsx', 'XLSX (Microsoft Excel)'],
];
const PASSWORD_RULE = 'Your password must be at least 12 characters and include one uppercase letter, lowercase letter, number, and special character.';
/** Zoho's rule for a file password. */
export function passwordProblem(p: string): string | null {
  if (!p) return null;
  return p.length >= 12 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /\d/.test(p) && /[^A-Za-z0-9]/.test(p) ? null : PASSWORD_RULE;
}

function Formats({ value, onChange }: { value: ExportFormat; onChange: (f: ExportFormat) => void }) {
  return (
    <div className="space-y-1.5" role="radiogroup" aria-label="Export File Format">
      {FORMATS.map(([v, l]) => (
        <label key={v} className="flex cursor-pointer items-center gap-2 text-[13px]">
          <input type="radio" name="export-format" className="size-3.5 accent-primary" checked={value === v} onChange={() => onChange(v)} data-slot={`export-format-${v}`} /> {l}
        </label>
      ))}
    </div>
  );
}

function Password({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const problem = passwordProblem(value);
  return (
    <label className="block space-y-1 text-[13px]">
      <span>File Protection Password</span>
      <Input type="password" value={value} onChange={(e) => onChange(e.target.value)} aria-label="File Protection Password" autoComplete="new-password" data-slot="export-password" />
      <span className={problem && value ? 'block text-[12px] text-destructive' : 'block text-[12px] text-muted-foreground'}>{PASSWORD_RULE}</span>
    </label>
  );
}

function Note({ rows }: { rows: string }) {
  return (
    <p className="rounded-[var(--radius-card)] bg-muted/60 px-3 py-2 text-[12px] text-muted-foreground">
      <span className="font-medium text-foreground">Note:</span> You can export only the first {rows} rows. If you have more rows, please take a backup of the data in your organisation, and download it.{' '}
      <Link href="/settings?tab=backups" className="text-link hover:underline">Backup Your Data</Link>
    </p>
  );
}

export interface ExportModule {
  value: string;
  label: string;
  /** The sheets this module exports: every record, or those of the period; personal data left out unless asked. */
  sheets: (opts: { from: string | null; to: string | null; pii: boolean }) => Promise<Sheet[]> | Sheet[];
}

/** Zoho's "Export Customers" / "Export Items". */
export function ExportDialog({ open, onOpenChange, title, noun, modules, filename, pii = true }: {
  open: boolean; onOpenChange: (o: boolean) => void;
  /** "Export Customers". */
  title: string;
  /** "Customers": the "All Customers" choice. */
  noun: string;
  modules: ExportModule[];
  filename: string;
  /** Whether the module holds personal data to leave out (a customer's email and phone). */
  pii?: boolean;
}) {
  const [module, setModule] = useState(modules[0]?.value ?? '');
  const [period, setPeriod] = useState<'all' | 'period'>('all');
  const [from, setFrom] = useState(`${today().slice(0, 4)}-04-01`);
  const [to, setTo] = useState(today());
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [withPii, setWithPii] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const problem = passwordProblem(password);
    if (problem) { toast.error(problem); return; }
    const m = modules.find((x) => x.value === module) ?? modules[0];
    setBusy(true);
    try {
      const sheets = await m.sheets({ from: period === 'period' ? from : null, to: period === 'period' ? to : null, pii: withPii });
      const capped = sheets.map((s) => ({ ...s, rows: s.rows.slice(0, 25001) }));
      downloadExport(`${filename}-${m.value}`, capped, format, password || undefined);
      onOpenChange(false);
    } catch (e) {
      toast.error('Not exported', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-slot="export-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>You can export your data from Rekonza in CSV, XLS or XLSX format.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-[13px]">
          <label className="block space-y-1">
            <span>Module</span>
            <select value={module} onChange={(e) => setModule(e.target.value)} aria-label="Module" data-slot="export-module"
              className="h-[34px] w-full rounded-[var(--radius-button)] border border-input bg-background px-2 text-[13px] outline-none focus:border-primary">
              {modules.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </label>
          <div className="space-y-1.5" role="radiogroup" aria-label="Period">
            <label className="flex cursor-pointer items-center gap-2"><input type="radio" name="export-period" className="size-3.5 accent-primary" checked={period === 'all'} onChange={() => setPeriod('all')} /> All {noun}</label>
            <label className="flex cursor-pointer items-center gap-2"><input type="radio" name="export-period" className="size-3.5 accent-primary" checked={period === 'period'} onChange={() => setPeriod('period')} data-slot="export-specific" /> Specific Period</label>
            {period === 'period' && (
              <div className="flex items-center gap-2 pl-6">
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-[33px] w-40" aria-label="From" />
                <span>-</span>
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-[33px] w-40" aria-label="To" />
              </div>
            )}
          </div>
          <div className="space-y-1.5"><p>Export File Format</p><Formats value={format} onChange={setFormat} /></div>
          {pii && (
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" className="size-3.5 accent-primary" checked={withPii} onChange={(e) => setWithPii(e.target.checked)} data-slot="export-pii" />
              Include Sensitive Personally Identifiable Information (PII) while exporting.
            </label>
          )}
          <Password value={password} onChange={setPassword} />
          <Note rows="25,000" />
        </div>
        <DialogFooter>
          <Button disabled={busy} onClick={() => void go()} data-slot="export-go">{busy ? 'Exporting…' : 'Export'}</Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Zoho's "Export Current View": the view's visible columns, as they stand. */
export function ExportViewDialog({ open, onOpenChange, filename, sheet }: {
  open: boolean; onOpenChange: (o: boolean) => void; filename: string; sheet: () => Sheet;
}) {
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [password, setPassword] = useState('');
  const go = () => {
    const problem = passwordProblem(password);
    if (problem) { toast.error(problem); return; }
    const s = sheet();
    downloadExport(filename, [{ ...s, rows: s.rows.slice(0, 10001) }], format, password || undefined);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-slot="export-view-dialog">
        <DialogHeader>
          <DialogTitle>Export Current View</DialogTitle>
          <DialogDescription>Only the current view with its visible columns will be exported from Rekonza in CSV or XLS format.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-[13px]">
          <div className="space-y-1.5"><p>Export File Format</p><Formats value={format} onChange={setFormat} /></div>
          <Password value={password} onChange={setPassword} />
          <Note rows="10,000" />
        </div>
        <DialogFooter>
          <Button onClick={go} data-slot="export-view-go">Export</Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
