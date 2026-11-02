'use client';

// Bringing bank transactions in — one statement or a pile of them at once.
//
// Every file is read in the browser on purpose. Every Indian bank exports a
// slightly different shape, and the column mapping is something a person has
// to see and confirm — so the server only ever receives normalised rows, and
// none of those bank-specific quirks live in it. CSV, TSV and Excel are read
// with the columns guessed and open to correction (Zoho's "map fields" step);
// OFX/QFX, QIF, CAMT.053, MT940 and JSON are read as their formats define.
//
// Several statements can be dropped together: each finds its own bank account
// from the account number it names (or the last four digits in its file name),
// and any it cannot place goes to the account chosen as the default.
//
// Duplicate lines are skipped by the importer, not by the user. Re-importing an
// overlapping statement is normal, and a fingerprint of each line is what stops
// it doubling the balance. An import can be undone while its lines are still
// uncategorised.

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import Papa from 'papaparse';
import { CheckCircle2, Download, FileSpreadsheet, Info, ListChecks, Loader2, Settings2, Trash2, Undo2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Combobox } from '@/components/ui/combobox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { Field } from '@/components/shared/form-bits';
import { AsyncPage } from '@/components/shared/async-state';
import { Money } from '@/components/shared/money';
import { api, ApiError, files as fileApi } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import {
  guessMapping, MAPPING_FIELDS, readWithMapping, type DateOrder, type StatementMapping, type StatementRow,
} from '@/lib/bank-statement';
import {
  accountInGrid, detectFormat, matchAccount, parseCamt, parseJsonStatement, parseMt940, parseOfx, parseQif,
  STATEMENT_ACCEPT, type StatementFormat,
} from '@/lib/bank-formats';

/** A sample statement the user can download, edit and re-upload. */
const SAMPLE_CSV = `Date,Narration,Reference,Debit,Credit
2026-08-06,NEFT CR TRICHY SPARE POINT,N2026080601,,58500.00
2026-08-05,BHARAT PETRO FUEL OMR,POS9912,3200.00,
2026-08-04,SWIFT LOGISTICS FREIGHT AUG,N2026080402,18500.00,
2026-08-03,UPI CR HOSUR AUTO AGENCIES,UPI7781234,,96000.00
2026-08-02,BANK CHARGES RTGS,CHG9931,354.00,
`;

const FORMAT_LABEL: Record<StatementFormat, string> = {
  csv: 'CSV', xlsx: 'Excel', ofx: 'OFX', qif: 'QIF', camt: 'CAMT.053', mt940: 'MT940', json: 'JSON',
};

interface BankAccountRow { id: string; name: string; kind: string; bankName: string | null; accountLast4: string | null }

interface ImportRow {
  id: string; filename: string; bankName: string; rowsTotal: number; rowsImported: number; rowsDuplicate: number;
  matched: number; lines: number; periodFrom: string | null; periodTo: string | null; importedBy: string | null; at: string;
}

interface QueuedFile {
  key: string;
  /** Kept so the statement is filed in Documents once imported. */
  file?: File;
  name: string;
  format: StatementFormat;
  /** Spreadsheet-like files keep their grid, so the columns can be re-mapped. */
  grid: unknown[][] | null;
  mapping: StatementMapping | null;
  rows: StatementRow[];
  accountHint: string | null;
  /** Empty until placed: by the file itself, or by the default account. */
  accountId: string;
  autoPlaced: boolean;
  problem: string | null;
  status: 'ready' | 'importing' | 'done' | 'failed';
  result?: { imported: number; duplicates: number; autoMatched: number };
  error?: string;
}

const short = (d: string | null) => (d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

async function readFile(file: File): Promise<Omit<QueuedFile, 'key' | 'accountId' | 'autoPlaced' | 'status'>> {
  const head = /\.xlsx?$/i.test(file.name) ? '' : (await file.slice(0, 4096).text());
  const format = detectFormat(file.name, head);
  const base = { name: file.name, format, grid: null, mapping: null, accountHint: null };
  if (format === 'xlsx') {
    if (/\.xls$/i.test(file.name)) {
      return { ...base, rows: [], problem: 'Old .xls files cannot be read here. Open it in Excel and save as .xlsx, or download the statement as CSV.' };
    }
    const { default: readXlsxFile } = await import('read-excel-file/browser');
    const sheets = (await readXlsxFile(file)) as unknown as { sheet: string; data: unknown[][] }[];
    const grid = sheets.find((s) => s.data.some((r) => r.some((c) => c !== null && c !== '')))?.data ?? [];
    return fromGrid(base, grid);
  }
  const text = await file.text();
  if (format === 'ofx') return { ...base, ...parseOfx(text) };
  if (format === 'qif') return { ...base, ...parseQif(text) };
  if (format === 'camt') return { ...base, ...parseCamt(text) };
  if (format === 'mt940') return { ...base, ...parseMt940(text) };
  if (format === 'json') return { ...base, ...parseJsonStatement(text) };
  const grid = Papa.parse<string[]>(text.replace(/^﻿/, ''), { skipEmptyLines: true }).data;
  return fromGrid(base, grid);
}

function fromGrid(base: { name: string; format: StatementFormat; grid: null; mapping: null; accountHint: null }, grid: unknown[][]) {
  const mapping = guessMapping(grid);
  const accountHint = accountInGrid(grid);
  if (!mapping) return { ...base, grid, accountHint, rows: [], problem: 'No header row with a date and a description was found. Map the columns by hand.' };
  const { rows, problem } = readWithMapping(grid, mapping);
  return { ...base, grid, mapping, accountHint, rows, problem };
}

export default function BankImportsPage() {
  const canImport = usePermission('banking', 'create');
  const canEdit = usePermission('banking', 'edit');
  const fileRef = useRef<HTMLInputElement>(null);
  const [defaultAccount, setDefaultAccount] = useState('');
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [mapping, setMapping] = useState<QueuedFile | null>(null);
  const [running, setRunning] = useState(false);

  const accounts = useApi<{ accounts: BankAccountRow[] }>(() => api.get('/api/banking/accounts'), []);
  const history = useApi<{ imports: ImportRow[] }>(() => api.get('/api/banking/import'), []);

  const list = accounts.data?.accounts ?? [];
  const options = list.map((a) => ({
    value: a.id,
    label: a.name,
    sublabel: a.accountLast4 ? `${a.bankName ?? a.kind} ····${a.accountLast4}` : a.kind,
  }));
  const fallback = defaultAccount || options[0]?.value || '';

  const addFiles = async (files: FileList | File[]) => {
    const picked = [...files];
    if (!picked.length) return;
    const read = await Promise.all(picked.map(async (f, i) => {
      try {
        const r = await readFile(f);
        const placed = matchAccount(list, r.accountHint, f.name);
        return { ...r, file: f, key: `${Date.now()}-${i}-${f.name}`, accountId: placed?.id ?? '', autoPlaced: !!placed, status: 'ready' as const };
      } catch {
        return { name: f.name, format: 'csv' as StatementFormat, grid: null, mapping: null, rows: [], accountHint: null, key: `${Date.now()}-${i}`, accountId: '', autoPlaced: false, status: 'ready' as const, problem: 'Could not read that file.' };
      }
    }));
    setQueue((q) => [...q, ...read]);
    const ok = read.filter((r) => r.rows.length).length;
    toast.success(`${picked.length} file${picked.length === 1 ? '' : 's'} read`, {
      description: `${ok} ready to import${read.some((r) => r.autoPlaced) ? `; ${read.filter((r) => r.autoPlaced).length} matched to their bank account by account number` : ''}.`,
    });
  };

  const update = (key: string, patch: Partial<QueuedFile>) => setQueue((q) => q.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  const importAll = async () => {
    const todo = queue.filter((f) => f.status !== 'done' && f.rows.length > 0);
    if (!todo.length) return;
    if (!fallback && todo.some((f) => !f.accountId)) {
      toast.error('Pick the account to import into first.');
      return;
    }
    setRunning(true);
    let lines = 0;
    let dupes = 0;
    for (const f of todo) {
      update(f.key, { status: 'importing' });
      try {
        const r = await api.post<{ importId: string; imported: number; duplicates: number; autoMatched: number }>('/api/banking/import', {
          bankAccountId: f.accountId || fallback, filename: f.name, rows: f.rows,
        });
        // The statement itself is filed in Documents → Bank statements, beside its import.
        if (f.file && f.file.size <= 10 * 1024 * 1024) await fileApi.upload('bank_import', r.importId, f.file).catch(() => undefined);
        lines += r.imported;
        dupes += r.duplicates;
        update(f.key, { status: 'done', result: r });
      } catch (e) {
        update(f.key, { status: 'failed', error: e instanceof ApiError ? e.message : 'The statement was not imported' });
      }
    }
    setRunning(false);
    history.refetch();
    toast.success(`${lines} transaction${lines === 1 ? '' : 's'} imported from ${todo.length} file${todo.length === 1 ? '' : 's'}`, {
      description: dupes ? `${dupes} duplicate line(s) were skipped automatically.` : 'No duplicates found.',
    });
  };

  const undo = async (imp: ImportRow) => {
    try {
      const r = await api.delete<{ removed: number; kept: number }>(`/api/banking/import?id=${imp.id}`);
      toast.success(`Import undone: ${r.removed} line(s) removed`, { description: r.kept ? `${r.kept} line(s) already matched were kept.` : undefined });
      history.refetch();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not undo the import');
    }
  };

  const downloadSample = () => {
    const blob = new Blob([SAMPLE_CSV], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sample-bank-statement.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const ready = queue.filter((f) => f.status !== 'done' && f.rows.length > 0);

  return (
    <>
      <PageHeader
        title="Import statements"
        description="Upload one statement or many at once. Duplicate lines are detected and skipped, and each file finds its own account."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/banking/statement-lines"><ListChecks className="mr-1.5 size-3.5" /> Categorise lines in bulk</Link>
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <Card className="space-y-4 p-5">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1">
              <Field label="Default account (for files that do not name theirs)">
                <Combobox options={options} value={fallback} onChange={setDefaultAccount} placeholder="Select account" searchPlaceholder="Search accounts" />
              </Field>
            </div>
            <Button variant="outline" size="sm" onClick={downloadSample} className="gap-1.5">
              <Download className="size-3.5" /> Sample file
            </Button>
          </div>

          <div
            onClick={() => canImport && fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (canImport) void addFiles(e.dataTransfer.files);
            }}
            className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 text-center transition-colors hover:border-primary/50 hover:bg-accent/40"
          >
            <Upload className="mb-2 size-6 text-muted-foreground" />
            <p className="text-sm font-medium">Drop statements here, or click to browse</p>
            <p className="mt-1 text-xs text-muted-foreground">Several at once. CSV, TSV, Excel (.xlsx), OFX/QFX, QIF, CAMT.053 (XML), MT940 or JSON</p>
          </div>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={STATEMENT_ACCEPT}
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = '';
            }}
          />

          {queue.length > 0 && (
            <div className="space-y-3">
              <div className="overflow-x-auto thin-scroll rounded-md border">
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50 text-xs text-muted-foreground">
                      <th className="px-3 py-2 text-left font-semibold">File</th>
                      <th className="px-3 py-2 text-left font-semibold">Import into</th>
                      <th className="px-3 py-2 text-right font-semibold">Lines</th>
                      <th className="px-3 py-2 text-left font-semibold">Period</th>
                      <th className="px-3 py-2 text-right font-semibold">In / out</th>
                      <th className="px-3 py-2 text-left font-semibold">Status</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {queue.map((f) => {
                      const dates = f.rows.map((r) => r.date).sort();
                      const inn = f.rows.reduce((t, r) => t + r.depositPaise, 0);
                      const out = f.rows.reduce((t, r) => t + r.withdrawalPaise, 0);
                      return (
                        <tr key={f.key} className="border-b align-top last:border-0">
                          <td className="px-3 py-2">
                            <p className="max-w-56 truncate font-medium" title={f.name}>{f.name}</p>
                            <Badge variant="outline" className="mt-0.5 text-[10px]">{FORMAT_LABEL[f.format]}</Badge>
                            {f.accountHint && <span className="ml-1.5 text-[11px] text-muted-foreground">A/c ····{f.accountHint.replace(/\D/g, '').slice(-4)}</span>}
                          </td>
                          <td className="w-56 px-3 py-2">
                            <Combobox options={options} value={f.accountId || fallback} onChange={(v) => update(f.key, { accountId: v, autoPlaced: false })}
                              placeholder="Select account" searchPlaceholder="Search accounts" disabled={f.status === 'done' || f.status === 'importing'} />
                            {f.autoPlaced && <p className="mt-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">Found from the account number</p>}
                          </td>
                          <td className="px-3 py-2 text-right tabular">{f.rows.length}</td>
                          <td className="px-3 py-2 text-xs">{dates.length ? `${short(dates[0])} – ${short(dates[dates.length - 1])}` : '—'}</td>
                          <td className="px-3 py-2 text-right text-xs">
                            <span className="text-emerald-600 dark:text-emerald-400"><Money value={inn} /></span><br />
                            <span className="text-muted-foreground"><Money value={out} /></span>
                          </td>
                          <td className="px-3 py-2 text-xs">
                            {f.status === 'done' && f.result ? (
                              <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="size-3.5" /> {f.result.imported} imported{f.result.duplicates ? `, ${f.result.duplicates} skipped` : ''}{f.result.autoMatched ? `, ${f.result.autoMatched} auto-matched` : ''}</span>
                            ) : f.status === 'importing' ? (
                              <span className="flex items-center gap-1"><Loader2 className="size-3.5 animate-spin" /> Importing…</span>
                            ) : f.status === 'failed' ? (
                              <span className="text-destructive">{f.error}</span>
                            ) : f.problem ? (
                              <span className="text-destructive">{f.problem}</span>
                            ) : (
                              <span className="text-muted-foreground">Ready</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-right">
                            {f.grid && f.status !== 'done' && (
                              <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={() => setMapping(f)} title="Map the columns">
                                <Settings2 className="size-3.5" /> Map
                              </Button>
                            )}
                            {f.status !== 'importing' && (
                              <Button variant="ghost" size="icon" className="size-7" onClick={() => setQueue((q) => q.filter((x) => x.key !== f.key))} aria-label={`Remove ${f.name}`}>
                                <X className="size-3.5" />
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setQueue([])} disabled={running} className="gap-1.5"><Trash2 className="size-3.5" /> Clear</Button>
                <Button onClick={() => void importAll()} disabled={running || !ready.length || !canImport} className="gap-1.5">
                  {running ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                  Import {ready.length > 1 ? `all ${ready.length} files` : ready.length === 1 ? '1 file' : ''} ({ready.reduce((t, f) => t + f.rows.length, 0)} lines)
                </Button>
              </div>
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card className="space-y-3 p-5">
            <h3 className="text-sm font-semibold">What can be uploaded</h3>
            <ul className="space-y-1.5 text-xs text-muted-foreground">
              <li><b className="text-foreground">CSV, TSV and Excel</b> as any Indian bank downloads them; the columns are found and can be re-mapped.</li>
              <li><b className="text-foreground">OFX / QFX</b> and <b className="text-foreground">QIF</b> from net banking and personal finance tools.</li>
              <li><b className="text-foreground">CAMT.053</b> and <b className="text-foreground">MT940</b> from corporate net banking.</li>
              <li><b className="text-foreground">JSON</b>: a list of lines, or Rekonza&apos;s own export of statement lines.</li>
            </ul>
          </Card>
          <Card className="space-y-3 p-5">
            <h3 className="text-sm font-semibold">Automatic bank feeds</h3>
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
              <Info className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="text-xs leading-relaxed text-muted-foreground">
                A live feed in India runs through the Account Aggregator framework, which needs a licensed aggregator as a partner — a
                commercial arrangement rather than a feature. Until then, uploading statements is the way in, and duplicate detection means
                re-uploading an overlapping period costs nothing.
              </p>
            </div>
          </Card>
        </div>
      </div>

      <Card className="p-5">
        <h3 className="mb-3 text-sm font-semibold">Import history</h3>
        <AsyncPage state={history}>
          {(d) =>
            d.imports.length === 0 ? (
              <p className="text-sm text-muted-foreground">No imports yet.</p>
            ) : (
              <div className="divide-y">
                {d.imports.map((b) => (
                  <div key={b.id} className="flex flex-wrap items-center gap-3 py-3">
                    <FileSpreadsheet className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{b.filename}</p>
                      <p className="text-xs text-muted-foreground">
                        {b.bankName} · {short(b.periodFrom)} – {short(b.periodTo)}
                        {b.importedBy ? ` · by ${b.importedBy}` : ''}
                      </p>
                    </div>
                    <Badge variant="secondary" className="text-[10px]">{b.rowsImported} lines</Badge>
                    {b.rowsDuplicate > 0 && <Badge variant="outline" className="text-[10px]">{b.rowsDuplicate} skipped</Badge>}
                    <Badge variant="outline" className={'text-[10px] ' + (b.lines > 0 && b.matched === b.lines ? 'border-emerald-500/40' : '')}>
                      {b.matched} of {b.lines} matched
                    </Badge>
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" asChild>
                      <Link href={`/banking/statement-lines?import=${b.id}`}>View lines</Link>
                    </Button>
                    {canEdit && b.matched < b.lines && (
                      <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => void undo(b)}>
                        <Undo2 className="size-3" /> Undo import
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )
          }
        </AsyncPage>
      </Card>

      {mapping && mapping.grid && (
        <MappingDialog
          file={mapping}
          onClose={() => setMapping(null)}
          onSave={(m) => {
            const { rows, problem } = readWithMapping(mapping.grid!, m);
            update(mapping.key, { mapping: m, rows, problem });
            setMapping(null);
            toast.success(`${rows.length} line(s) read with the new mapping`);
          }}
        />
      )}
    </>
  );
}

/** Zoho's "map fields": which column is which, and how dates are written. */
function MappingDialog({ file, onClose, onSave }: { file: QueuedFile; onClose: () => void; onSave: (m: StatementMapping) => void }) {
  const grid = file.grid!;
  const [m, setM] = useState<StatementMapping>(() => file.mapping ?? {
    headerAt: 0, date: -1, narration: -1, reference: -1, withdrawal: -1, deposit: -1, amount: -1, drcr: -1, balance: -1, dateOrder: 'dmy',
  });
  const header = (grid[m.headerAt] ?? []).map((c, i) => String(c ?? '').trim() || `Column ${i + 1}`);
  const preview = useMemo(() => readWithMapping(grid, m), [grid, m]);
  const rowsAbove = grid.slice(0, 25).map((r, i) => ({ i, text: r.map((c) => String(c ?? '')).filter(Boolean).join(' · ').slice(0, 90) }));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Map the columns of {file.name}</DialogTitle>
          <DialogDescription>Tell the import which column is which. The preview below updates as you choose.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 sm:col-span-2">
            <span className="text-xs font-medium text-muted-foreground">The row with the column headings</span>
            <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={m.headerAt} onChange={(e) => setM({ ...m, headerAt: Number(e.target.value) })}>
              {rowsAbove.map((r) => <option key={r.i} value={r.i}>Row {r.i + 1}: {r.text || '(empty)'}</option>)}
            </select>
          </label>
          {MAPPING_FIELDS.map((f) => (
            <label key={f.key} className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{f.label}{f.required ? ' *' : ''}</span>
              <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={m[f.key]} onChange={(e) => setM({ ...m, [f.key]: Number(e.target.value) })}>
                <option value={-1}>— none —</option>
                {header.map((h, i) => <option key={i} value={i}>{h}</option>)}
              </select>
            </label>
          ))}
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Date format</span>
            <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={m.dateOrder} onChange={(e) => setM({ ...m, dateOrder: e.target.value as DateOrder })}>
              <option value="dmy">dd/mm/yyyy (Indian banks)</option>
              <option value="mdy">mm/dd/yyyy</option>
              <option value="ymd">yyyy-mm-dd</option>
            </select>
          </label>
        </div>
        <div className="rounded-md border">
          <p className="border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
            {preview.problem ? <span className="text-destructive">{preview.problem}</span> : `${preview.rows.length} line(s) will be imported. The first five:`}
          </p>
          <table className="w-full text-xs">
            <tbody>
              {preview.rows.slice(0, 5).map((r, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="whitespace-nowrap px-3 py-1.5">{r.date}</td>
                  <td className="px-3 py-1.5">{r.narration}</td>
                  <td className="px-3 py-1.5 text-right">{r.withdrawalPaise ? <Money value={-r.withdrawalPaise} /> : <span className="text-emerald-600 dark:text-emerald-400"><Money value={r.depositPaise} /></span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSave(m)} disabled={!!preview.problem}>Use this mapping</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
