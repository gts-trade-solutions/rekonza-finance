'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Bringing data in.
//
// Two steps, and the second is the one that matters. Reading a file is easy;
// reading it *right* — that "01/04/2026" is April and not January, that the
// last row is a grand total, that a PIN code is not a quantity — is where every
// import tool earns or loses trust. So nothing is saved until the user has seen
// what each column was taken to be, in words, and could change it.
//
// Files are parsed here in the browser. Nothing is sent anywhere until the
// user presses Create, and then only the table they approved.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type DragEvent } from 'react';
import Papa from 'papaparse';
import {
  ArrowLeft, BookOpen, ClipboardPaste, FileSpreadsheet, Info, Loader2, Lock, Sparkles, TriangleAlert, Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { Field } from '@/components/shared/form-bits';
import { OptionSelect } from '@/components/analytics/option-select';
import { MONTHS } from '@/lib/analytics/dates';
import { TYPE_LABELS, formatValue } from '@/lib/analytics/format';
import { MAX_COLUMNS, MAX_ROWS, importGrid, type ColumnOverride, type RawCell } from '@/lib/analytics/infer';
import { MAX_DATASET_BYTES } from '@/lib/analytics/schema';
import type { Cell, ColumnRole, ColumnSchema, ColumnType } from '@/lib/analytics/types';
import { analytics } from '@/lib/api/analytics';
import { useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';

type Source = 'upload' | 'paste' | 'books' | 'sample';

const MAX_FILE_BYTES = 25 * 1024 * 1024;

const numeric = (t: ColumnType) => t === 'number' || t === 'currency' || t === 'percent';

function show(v: Cell, type: ColumnType): string {
  if (v === null) return '—';
  if (type === 'date' && typeof v === 'string') {
    const [y, m, d] = v.split('-').map(Number);
    return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
  }
  if (typeof v === 'number') return formatValue(v, type === 'currency' ? 'inr' : type === 'percent' ? 'percent' : 'decimal').replace(/\.00$/, '');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return v;
}

/** A sample value as it will read on a chart: 01 Apr 2026, ₹15,000, 7.5%. */
const example = (s: string, type: ColumnType): string =>
  type === 'date' ? show(s, 'date') : numeric(type) && s.trim() !== '' && Number.isFinite(Number(s)) ? show(Number(s), type) : s;

export default function NewAnalyticsPage() {
  const router = useRouter();
  const canCreate = usePermission('analytics', 'create');

  const [source, setSource] = useState<Source>('upload');
  const [grid, setGrid] = useState<RawCell[][] | null>(null);
  const [sheets, setSheets] = useState<{ sheet: string; data: RawCell[][] }[]>([]);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [fileName, setFileName] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [hasHeader, setHasHeader] = useState<boolean | 'auto'>('auto');
  const [overrides, setOverrides] = useState<Record<number, ColumnOverride>>({});
  // Renames are kept apart from the import: a new name should not re-read a
  // column's type from scratch while the user is still typing it.
  const [labels, setLabels] = useState<Record<number, string>>({});
  const [pasted, setPasted] = useState('');
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sizeError, setSizeError] = useState<string | null>(null);

  const imported = useMemo(() => (grid ? importGrid(grid, { hasHeader, overrides }) : null), [grid, hasHeader, overrides]);

  const create = useApiAction(analytics.createDataset);
  const built = useApiAction(async (s: 'books' | 'sample') => analytics.createDataset({ source: s, createReport: true }));

  const reset = (g: RawCell[][], file: string | null, base: string) => {
    setGrid(g);
    setFileName(file);
    setName(base.slice(0, 150));
    setOverrides({});
    setLabels({});
    setHasHeader('auto');
    setSizeError(null);
    create.reset();
  };

  const readFile = async (file: File) => {
    setReadError(null);
    if (file.size > MAX_FILE_BYTES) {
      setReadError('That file is over 25 MB. Remove columns or rows you do not need, or split it, and try again.');
      return;
    }
    setReading(true);
    try {
      const base = file.name.replace(/\.[^.]+$/, '');
      if (/\.xlsx$/i.test(file.name)) {
        const { default: readXlsxFile } = await import('read-excel-file/browser');
        const all = (await readXlsxFile(file)) as unknown as { sheet: string; data: RawCell[][] }[];
        const usable = all.filter((s) => s.data.some((r) => r.some((c) => c !== null && c !== '')));
        if (!usable.length) throw new Error('That workbook has no data in it.');
        setSheets(usable);
        setSheetIdx(0);
        reset(usable[0].data, file.name, base);
      } else if (/\.xls$/i.test(file.name)) {
        throw new Error('Older .xls workbooks cannot be read here. Open it in Excel, save it as .xlsx or CSV, and upload that.');
      } else {
        const text = (await file.text()).replace(/^﻿/, '');
        const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' });
        if (!parsed.data.length) throw new Error('That file has no rows in it.');
        setSheets([]);
        reset(parsed.data, file.name, base);
      }
    } catch (e) {
      setReadError(e instanceof Error && e.message ? e.message : 'That file could not be read. Is it a CSV or an Excel .xlsx file?');
    } finally {
      setReading(false);
    }
  };

  const readPasted = () => {
    setReadError(null);
    const parsed = Papa.parse<string[]>(pasted.trim(), { skipEmptyLines: 'greedy' });
    if (!parsed.data.length) {
      setReadError('Nothing to read. Paste some rows first.');
      return;
    }
    setSheets([]);
    reset(parsed.data, null, 'Pasted data');
  };

  const startBuilt = async (s: 'books' | 'sample') => {
    const res = await built.run(s);
    if (res?.reportId) router.push(`/analytics/reports/${res.reportId}`);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void readFile(f);
  };

  // ── Column edits ──

  const setOverride = (i: number, patch: ColumnOverride) =>
    setOverrides((o) => {
      const next = { ...o[i], ...patch };
      // A column that no longer holds numbers cannot be added up.
      if (patch.type && !numeric(patch.type)) delete next.role;
      return { ...o, [i]: next };
    });

  const finalColumns = (): ColumnSchema[] => {
    if (!imported) return [];
    const seen = new Set<string>();
    return imported.columns.map((c) => {
      const src = Number(c.key.slice(1));
      let label = (labels[src]?.trim() || c.label).slice(0, 80);
      // Two columns cannot share a name — a chart would not know which it meant.
      for (let n = 2; seen.has(label.toLowerCase()); n++) label = `${(labels[src]?.trim() || c.label).slice(0, 74)} (${n})`;
      seen.add(label.toLowerCase());
      return { ...c, label };
    });
  };

  const save = async () => {
    if (!imported) return;
    setSizeError(null);
    const columns = finalColumns();
    const body = { source: source === 'paste' ? ('paste' as const) : ('upload' as const), name: name.trim(), sourceName: fileName, columns, rows: imported.rows, createReport: true };
    if (JSON.stringify(body).length > MAX_DATASET_BYTES) {
      setSizeError('This is more data than one dataset can hold. Leave out columns you do not need (untick them above), or import fewer rows.');
      return;
    }
    const res = await create.run(body);
    if (res?.reportId) router.push(`/analytics/reports/${res.reportId}`);
    else if (res) router.push(`/analytics/datasets/${res.id}`);
  };

  if (!canCreate) {
    return (
      <>
        <PageHeader title="New report" />
        <EmptyState
          icon={Lock}
          title="Your role can view reports but not create them"
          description="Ask an administrator or accountant to build the report, or to change your role."
          action={
            <Button variant="outline" asChild>
              <Link href="/analytics">Back to Analytics</Link>
            </Button>
          }
        />
      </>
    );
  }

  const step = imported ? 2 : 1;

  return (
    <>
      <PageHeader
        title="New report"
        description="Bring in the data, check how each column was read, and a first dashboard is built for you."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/analytics">
              <ArrowLeft className="size-3.5" /> Analytics
            </Link>
          </Button>
        }
      />

      <ol className="flex flex-wrap items-center gap-2 text-xs" aria-label="Steps">
        {['Choose the data', 'Check the columns', 'Your dashboard'].map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cn(
                'grid size-5 place-items-center rounded-full text-[10px] font-semibold',
                i + 1 <= step ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
              )}
            >
              {i + 1}
            </span>
            <span className={cn(i + 1 === step ? 'font-medium' : 'text-muted-foreground')}>{label}</span>
            {i < 2 && <span className="mx-1 h-px w-6 bg-border" />}
          </li>
        ))}
      </ol>

      {step === 1 && (
        <>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" role="radiogroup" aria-label="Where the data comes from">
            {(
              [
                { key: 'upload', icon: Upload, title: 'Upload a file', body: 'Excel (.xlsx) or CSV' },
                { key: 'paste', icon: ClipboardPaste, title: 'Paste cells', body: 'Straight from a spreadsheet' },
                { key: 'books', icon: BookOpen, title: 'From your books', body: 'Every sales invoice line' },
                { key: 'sample', icon: Sparkles, title: 'Sample data', body: 'Regional sales and budget' },
              ] as const
            ).map((s) => (
              <button
                key={s.key}
                type="button"
                role="radio"
                aria-checked={source === s.key}
                onClick={() => {
                  setSource(s.key);
                  setReadError(null);
                }}
                data-slot="source-option"
                data-source={s.key}
                className={cn(
                  'flex items-start gap-3 rounded-[3px] border bg-card p-3 text-left transition-colors',
                  source === s.key ? 'border-primary ring-1 ring-primary' : 'hover:border-primary/40',
                )}
              >
                <s.icon className={cn('mt-0.5 size-4 shrink-0', source === s.key ? 'text-primary' : 'text-muted-foreground')} />
                <span>
                  <span className="block text-sm font-medium">{s.title}</span>
                  <span className="block text-xs text-muted-foreground">{s.body}</span>
                </span>
              </button>
            ))}
          </div>

          {source === 'upload' && (
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={cn(
                'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-[3px] border-2 border-dashed bg-card px-6 py-14 text-center transition-colors',
                dragging ? 'border-primary bg-primary/5' : 'hover:border-primary/40',
              )}
              data-slot="dropzone"
            >
              {reading ? <Loader2 className="size-7 animate-spin text-primary" /> : <FileSpreadsheet className="size-7 text-muted-foreground" />}
              <span>
                <span className="block text-sm font-medium">{reading ? 'Reading…' : 'Drop a spreadsheet here, or click to choose one'}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  .xlsx, .csv or .tsv · up to {MAX_ROWS.toLocaleString('en-IN')} rows and {MAX_COLUMNS} columns · the file is read on this
                  computer and nothing is uploaded until you press Create
                </span>
              </span>
              <input
                type="file"
                accept=".xlsx,.csv,.tsv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="sr-only"
                disabled={reading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void readFile(f);
                  e.target.value = '';
                }}
                data-slot="file-input"
              />
            </label>
          )}

          {source === 'paste' && (
            <Card className="space-y-3 p-4">
              <Field label="Paste your cells" hint="Copy a range in Excel or Google Sheets — headings included — and paste it here. Tabs and commas both work.">
                <Textarea
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value)}
                  rows={10}
                  className="max-h-80 font-mono text-xs"
                  placeholder={'Month\tRegion\tRevenue\nApr 2026\tNorth\t1,25,000\nApr 2026\tSouth\t98,500'}
                  data-slot="paste-input"
                />
              </Field>
              <Button onClick={readPasted} disabled={!pasted.trim()}>
                Read the pasted cells
              </Button>
            </Card>
          )}

          {(source === 'books' || source === 'sample') && (
            <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{source === 'books' ? 'Sales from your books' : 'Regional sales and budget'}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {source === 'books'
                    ? 'One row per line on every sent or paid invoice: date, customer, item, place of supply, taxable value, GST and total. Drafts and voided invoices are left out. It is a snapshot — refresh it from the dataset page whenever you want the latest.'
                    : 'Twenty-nine months across four regions, four product lines and three channels, with a budget beside every figure — enough to see trend, mix and variance working together.'}
                </p>
              </div>
              <Button onClick={() => startBuilt(source)} disabled={built.busy} data-slot="build-source">
                {built.busy && <Loader2 className="size-4 animate-spin" />}
                {source === 'books' ? 'Build from my books' : 'Open the sample'}
              </Button>
            </Card>
          )}

          {(readError || built.error) && (
            <p className="flex items-start gap-2 text-sm text-destructive" role="alert">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {readError ?? built.error}
            </p>
          )}
        </>
      )}

      {step === 2 && imported && (
        <>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Button variant="outline" size="sm" onClick={() => setGrid(null)}>
              <ArrowLeft className="size-3.5" /> Choose different data
            </Button>
            {fileName && (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <FileSpreadsheet className="size-4" /> {fileName}
              </span>
            )}
            {sheets.length > 1 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Sheet</span>
                <OptionSelect<string>
                  value={String(sheetIdx)}
                  onChange={(v) => {
                    const i = Number(v);
                    setSheetIdx(i);
                    reset(sheets[i].data, fileName, name);
                  }}
                  options={sheets.map((s, i) => ({ value: String(i), label: s.sheet }))}
                  className="w-44"
                  label="Sheet"
                />
              </div>
            )}
          </div>

          <Card className="grid gap-4 p-4 md:grid-cols-[1fr_auto] md:items-end">
            <Field label="Dataset name" required hint="Reports built from it will show this name.">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={150} data-slot="dataset-name" />
            </Field>
            <label className="flex items-center gap-3 pb-1 text-sm">
              <Switch checked={imported.hasHeader} onCheckedChange={(v) => setHasHeader(v)} />
              First row holds the column names
            </label>
          </Card>

          <div className="space-y-1.5" data-slot="import-summary">
            <p className="text-sm">
              <span className="font-medium">{imported.rows.length.toLocaleString('en-IN')} rows</span> and{' '}
              <span className="font-medium">{imported.columns.length} columns</span> will be imported
              {imported.droppedRows > 0 && (
                <span className="text-muted-foreground">
                  {' '}· {imported.droppedRows} {imported.droppedRows === 1 ? 'row was' : 'rows were'} left out
                </span>
              )}
              .
            </p>
            {imported.issues.map((iss, i) => (
              <p
                key={i}
                className={cn('flex items-start gap-2 text-xs', iss.level === 'warning' ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}
              >
                {iss.level === 'warning' ? <TriangleAlert className="mt-px size-3.5 shrink-0" /> : <Info className="mt-px size-3.5 shrink-0" />}
                {iss.message}
              </p>
            ))}
          </div>

          <Card className="overflow-hidden p-0">
            <div className="border-b px-4 py-3">
              <p className="text-sm font-semibold">How each column was read</p>
              <p className="text-xs text-muted-foreground">
                “Group by” columns split the data — region, customer, month. “Add up” columns are the numbers charts total. Change anything that looks wrong.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-slot="column-review">
                <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="w-10 px-3 py-2 font-medium">
                      <span className="sr-only">Include</span>
                    </th>
                    <th className="px-3 py-2 font-medium">Column</th>
                    <th className="px-3 py-2 font-medium">Holds</th>
                    <th className="px-3 py-2 font-medium">Use it to</th>
                    <th className="px-3 py-2 font-medium">Examples</th>
                  </tr>
                </thead>
                <tbody>
                  {imported.sourceColumns.map((sc) => {
                    const col = imported.columns.find((c) => c.key === `c${sc.index}`);
                    const type = col?.type ?? overrides[sc.index]?.type ?? 'text';
                    const role: ColumnRole = col?.role ?? 'dimension';
                    return (
                      <tr key={sc.index} className={cn('border-b align-top last:border-0', sc.skipped && 'bg-muted/30 text-muted-foreground')}>
                        <td className="px-3 py-2.5">
                          <Checkbox
                            checked={!sc.skipped}
                            onCheckedChange={(v) => setOverride(sc.index, { skip: !v })}
                            aria-label={`Include ${sc.label}`}
                          />
                        </td>
                        <td className="min-w-44 px-3 py-2">
                          <Input
                            value={labels[sc.index] ?? sc.label}
                            onChange={(e) => setLabels((l) => ({ ...l, [sc.index]: e.target.value }))}
                            maxLength={80}
                            disabled={sc.skipped}
                            className="h-8 text-xs"
                            aria-label={`Name of column ${sc.index + 1}`}
                          />
                          {col?.notes?.map((n) => (
                            <p key={n} className="mt-1 max-w-72 text-[11px] leading-snug text-muted-foreground">
                              {n}
                            </p>
                          ))}
                        </td>
                        <td className="min-w-36 px-3 py-2">
                          <OptionSelect<ColumnType>
                            value={type}
                            onChange={(t) => setOverride(sc.index, { type: t })}
                            options={(Object.keys(TYPE_LABELS) as ColumnType[]).map((t) => ({ value: t, label: TYPE_LABELS[t] }))}
                            disabled={sc.skipped}
                            className="h-8 text-xs"
                            label={`What ${sc.label} holds`}
                          />
                        </td>
                        <td className="min-w-32 px-3 py-2">
                          <OptionSelect<ColumnRole>
                            value={role}
                            onChange={(r) => setOverride(sc.index, { role: r })}
                            options={[
                              { value: 'dimension', label: 'Group by' },
                              { value: 'measure', label: 'Add up', disabled: !numeric(type) },
                            ]}
                            disabled={sc.skipped}
                            className="h-8 text-xs"
                            label={`How to use ${sc.label}`}
                          />
                        </td>
                        <td className="px-3 py-2.5 text-xs text-muted-foreground">
                          {sc.skipped
                            ? 'Left out'
                            : (col?.profile?.sample ?? []).slice(0, 3).map((s) => example(s, type)).join(' · ') || '—'}
                          {col?.profile && !sc.skipped && (
                            <span className="block text-[11px]">
                              {col.profile.distinct.toLocaleString('en-IN')} different
                              {col.profile.nulls ? ` · ${col.profile.nulls.toLocaleString('en-IN')} empty` : ''}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="overflow-hidden p-0">
            <div className="border-b px-4 py-3">
              <p className="text-sm font-semibold">First rows, as they will be stored</p>
            </div>
            <div className="max-h-96 overflow-auto">
              <table className="w-full text-xs" data-slot="import-preview">
                <thead className="sticky top-0 border-b bg-card text-left text-muted-foreground">
                  <tr>
                    {imported.columns.map((c) => (
                      <th key={c.key} className={cn('whitespace-nowrap px-3 py-2 font-medium', numeric(c.type) && 'text-right')}>
                        {labels[Number(c.key.slice(1))]?.trim() || c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {imported.rows.slice(0, 20).map((r, i) => (
                    <tr key={i} className="border-b border-border/60 last:border-0">
                      {imported.columns.map((c) => (
                        <td
                          key={c.key}
                          className={cn('max-w-60 truncate whitespace-nowrap px-3 py-1.5', numeric(c.type) && 'text-right tabular-nums', r[c.index] === null && 'text-muted-foreground')}
                        >
                          {show(r[c.index], c.type)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {(sizeError || create.error) && (
            <p className="flex items-start gap-2 text-sm text-destructive" role="alert">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {sizeError ?? create.error}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-4">
            <p className="mr-auto text-xs text-muted-foreground">
              Next: a starter dashboard is laid out from these columns. Every chart on it can be changed or removed.
            </p>
            <Button variant="outline" onClick={() => setGrid(null)}>
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={create.busy || !name.trim() || !imported.rows.length || !imported.columns.length}
              data-slot="create-dataset"
            >
              {create.busy && <Loader2 className="size-4 animate-spin" />}
              Create dashboard
            </Button>
          </div>
        </>
      )}
    </>
  );
}
