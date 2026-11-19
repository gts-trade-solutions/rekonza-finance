'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Import, as Zoho Books does it from each list's ⋯ menu: "Customers - Select
// File", then Map Fields, then Preview, then Import.
//
//   1 Configure   drop or choose a CSV, TSV, text, Excel (.xlsx or .xls) or
//                 JSON file; the sample files; the character encoding; what
//                 to do with records already in the books.
//   2 Map Fields  each Rekonza field with the file heading auto-selected for
//                 it (Zoho's own export headings included); saved for next
//                 time if asked.
//   3 Preview     the whole import run as a check and thrown away
//                 (lib/server/imports/run.ts): how many are ready, how many
//                 skipped, every row with a problem; nothing is saved until
//                 Import, which keeps everything or nothing.
//
// On the online demo nothing can be saved, so the preview reads the file in
// the browser and says so, instead of failing.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import { AlertTriangle, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Download, HelpCircle, Info, Lightbulb, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { downloadCsv } from '@/components/shared/report-shell';
import { ApiError, imports, type ImportResponse } from '@/lib/api/client';
import { usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';
import { downloadWorkbook } from '@/lib/xlsx';
import { cellText, readGrid } from '@/lib/imports/read-file';
import { readTallyReportGrid } from '@/lib/tally/reports';
import { columnFor, MAX_IMPORT_ROWS, TEMPLATES, templateCsv, templateSheets, type ColumnSpec } from '@/lib/imports/templates';
import { ENCODINGS, importModule, type ImportModule } from '@/lib/imports/modules';

const MAX_BYTES = 25 * 1024 * 1024;
const ACCEPT = '.csv,.tsv,.txt,.tab,.dsv,.psv,.prn,.xls,.xlsx,.json,text/csv,text/tab-separated-values,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type Step = 1 | 2 | 3;

interface Loaded {
  file: File;
  headings: string[];
  body: string[][];
  /** Each body row's line in the file, so a problem names the line the user sees in Excel. */
  lines: number[];
}

export default function ImportPage() {
  const { module: slug } = useParams<{ module: string }>();
  const m = importModule(slug);
  if (!m) {
    return (
      <div className="p-10 text-center text-sm text-muted-foreground">
        There is no import for this list. <Link href="/settings/import" className="text-link hover:underline">See every import</Link>.
      </div>
    );
  }
  return <Wizard m={m} />;
}

function Wizard({ m }: { m: ImportModule }) {
  const router = useRouter();
  const canImport = usePermission(m.module, 'create');
  const t = TEMPLATES[m.kind];
  const fields = useMemo(() => t.columns.filter((c) => !m.fixed || !(c.key in m.fixed)), [t, m]);
  const [step, setStep] = useState<Step>(1);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [encoding, setEncoding] = useState('utf-8');
  const [onDuplicate, setOnDuplicate] = useState<'skip' | 'error'>('skip');
  const [map, setMap] = useState<Record<string, string>>({});
  const [remember, setRemember] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  /** The file is one of Tally's reports ("Trial Balance"): said, with the way to the Tally import. */
  const [tallyReport, setTallyReport] = useState<string | null>(null);

  const saveKey = `rekonza.import-map.${m.slug}`;

  /** Read the file into headings and rows, under the encoding chosen. */
  const read = async (file: File, enc = encoding) => {
    if (file.size > MAX_BYTES) { toast.error('The file is larger than 25 MB. Split it and import each part.'); return; }
    if (/\.(pdf|png|jpe?g|webp)$/i.test(file.name)) {
      toast.error('This import takes a CSV, TSV or Excel file.', { description: 'Invoices as PDFs are read by Import → Invoices from PDF.' });
      return;
    }
    try {
      const { grid } = await readGrid(file, m.kind, 'auto', enc);
      // Tally's own reports list groups and their ledgers together: they are read on the Tally screen.
      const tallyLaid = grid.slice(0, 20).some((r) => r.some((c) => /^particulars$/i.test(cellText(c).trim())));
      const tally = tallyLaid ? readTallyReportGrid(grid.map((r) => r.map((c) => ({ v: typeof c === 'number' ? c : cellText(c) }))), 'Excel') : null;
      setTallyReport(tally ? tally.label : null);
      const rows = grid.map((r) => r.map((c) => cellText(c).trim()));
      const start = rows.findIndex((r) => r.filter(Boolean).length >= 2);
      if (start < 0 || rows.length - start < 2) throw new Error('The file needs a row of headings and at least one row under it.');
      const headings = rows[start];
      const kept = rows.map((r, i) => ({ r, line: i + 1 })).slice(start + 1).filter(({ r }) => r.some((c) => c !== ''));
      const body = kept.map((k) => k.r);
      if (body.length > MAX_IMPORT_ROWS) throw new Error(`The file has ${body.length} rows; import up to ${MAX_IMPORT_ROWS} at a time.`);
      setLoaded({ file, headings, body, lines: kept.map((k) => k.line) });
      // The best match for each field, or the selections saved last time for files with these headings.
      const saved = (() => { try { return JSON.parse(localStorage.getItem(saveKey) ?? 'null') as { headings: string[]; map: Record<string, string> } | null; } catch { return null; } })();
      const auto: Record<string, string> = {};
      for (const f of fields) {
        const h = headings.find((x) => columnFor(m.kind, x) === f.key);
        if (h) auto[f.key] = h;
      }
      if (saved && saved.headings.join('|') === headings.join('|')) { setMap({ ...auto, ...saved.map }); setRemember(true); } else setMap(auto);
    } catch (e) {
      toast.error('Could not read that file', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  /** The rows as the import reads them: each field from the heading mapped to it, and the fixed columns. */
  const rows = useMemo(() => {
    if (!loaded) return [];
    const idx = Object.fromEntries(Object.entries(map).filter(([, h]) => h).map(([k, h]) => [k, loaded.headings.indexOf(h)]));
    return loaded.body.map((r, n) => ({ ...Object.fromEntries(Object.entries(idx).map(([k, i]) => [k, i >= 0 ? r[i] ?? '' : ''])), ...(m.fixed ?? {}), __line: String(loaded.lines[n]) }));
  }, [loaded, map, m.fixed]);

  const unmapped = loaded ? loaded.headings.filter((h) => h && !Object.values(map).includes(h)) : [];

  const next = () => {
    if (step === 1) { if (loaded) setStep(2); return; }
    if (step === 2) {
      const missing = fields.filter((f) => f.required && !map[f.key]).map((f) => f.label);
      if (missing.length) { setMapError(`Please map the mandatory field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`); return; }
      setMapError(null);
      try {
        if (remember && loaded) localStorage.setItem(saveKey, JSON.stringify({ headings: loaded.headings, map }));
        else localStorage.removeItem(saveKey);
      } catch { /* private mode */ }
      setStep(3);
    }
  };

  return (
    <div className="-mx-4 -my-4 flex min-h-[calc(100vh-56px)] flex-col bg-background sm:-mx-6 sm:-my-6" data-slot="zoho-import" data-step={step}>
      <header className="relative border-b px-6 pb-4 pt-5 text-center">
        <h1 className="text-[18px] font-normal" data-slot="import-title">{step === 1 ? `${m.title} - Select File` : step === 2 ? 'Map Fields' : 'Preview'}</h1>
        <Stepper step={step} />
        <button type="button" onClick={() => router.push(m.back)} aria-label="Close" className="absolute right-6 top-5 text-[#e85b4f] hover:opacity-80"><X className="size-5" /></button>
      </header>

      <main className="flex flex-1 flex-col px-6 pb-28 pt-8">
        {!canImport && (
          <p className="mx-auto mb-6 max-w-[640px] rounded-[4px] border border-amber-300 bg-amber-50 px-4 py-2.5 text-[13px] text-amber-900">
            Your role can look at {m.title.toLowerCase()} but not add them, so the last step will not import.
          </p>
        )}
        {step === 1 && tallyReport && loaded && (
          <p className="mx-auto mb-6 flex max-w-[640px] items-start gap-2 rounded-[4px] border border-sky-200 bg-sky-50 px-4 py-2.5 text-[13px] text-sky-900" data-slot="import-tally-report">
            <span>
              This is Tally&apos;s <b>{tallyReport}</b>. Tally lists groups and their ledgers together in it, with each group&apos;s total, so read as rows it would count
              balances twice. <Link href="/tally/import" className="font-medium text-link hover:underline">Bring it in from Tally</Link> instead: that reads Tally&apos;s layout and brings the balances, items and bills in as Tally would.
            </span>
          </p>
        )}
        {step === 1 && (
          <Configure m={m} loaded={loaded} encoding={encoding} onDuplicate={onDuplicate}
            onFile={(f) => void read(f)} onRemove={() => { setLoaded(null); setMap({}); setTallyReport(null); }}
            onEncoding={(e) => { setEncoding(e); if (loaded) void read(loaded.file, e); }}
            onDuplicateChange={setOnDuplicate} />
        )}
        {step === 2 && loaded && (
          <MapFields m={m} fields={fields} loaded={loaded} map={map} setMap={setMap} remember={remember} setRemember={setRemember} error={mapError} />
        )}
        {step === 3 && loaded && (
          <Preview m={m} rows={rows} fields={fields} unmapped={unmapped} onDuplicate={onDuplicate} canImport={canImport}
            onDone={(n) => { toast.success(`${n} ${n === 1 ? m.noun : m.title.toLowerCase()} imported successfully.`); router.push(m.back); }}
            onBack={() => setStep(2)} />
        )}
      </main>

      {step !== 3 && (
        <footer className="sticky bottom-0 flex items-center justify-between border-t bg-background px-6 py-3" data-slot="import-footer">
          <div className="flex gap-2">
            {step === 2 && <Button variant="outline" size="sm" className="gap-1" onClick={() => setStep(1)}><ChevronLeft className="size-3.5" /> Previous</Button>}
            <Button size="sm" className="gap-1" disabled={!loaded} onClick={next} data-slot="import-next">Next <ChevronRight className="size-3.5" /></Button>
          </div>
          <Button variant="outline" size="sm" onClick={() => router.push(m.back)}>Cancel</Button>
        </footer>
      )}
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  const steps = ['Configure', 'Map Fields', 'Preview'];
  return (
    <ol className="mt-3 flex items-center justify-center gap-3 text-[13px]" data-slot="import-stepper">
      {steps.map((s, i) => {
        const n = (i + 1) as Step;
        const done = n < step;
        const on = n === step;
        return (
          <li key={s} className="flex items-center gap-3">
            {i > 0 && <span className="h-px w-8 bg-border" />}
            <span className={cn('flex items-center gap-2', !on && !done && 'text-muted-foreground')}>
              <span className={cn('grid size-6 place-items-center rounded-full border text-[12px]',
                done ? 'border-emerald-600 bg-emerald-600 text-white' : on ? 'border-primary bg-primary text-white' : 'border-border')}>
                {done ? <Check className="size-3.5" /> : n}
              </span>
              <span className={on ? 'font-semibold' : ''}>{s}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Configure({ m, loaded, encoding, onDuplicate, onFile, onRemove, onEncoding, onDuplicateChange }: {
  m: ImportModule; loaded: Loaded | null; encoding: string; onDuplicate: 'skip' | 'error';
  onFile: (f: File) => void; onRemove: () => void; onEncoding: (e: string) => void; onDuplicateChange: (v: 'skip' | 'error') => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const sampleCsv = () => {
    const lines = templateCsv(m.kind).split('\n').map((l) => Papa.parse<string[]>(l).data[0]);
    const fixed = Object.keys(m.fixed ?? {});
    const keep = TEMPLATES[m.kind].columns.map((c, i) => (fixed.includes(c.key) ? -1 : i)).filter((i) => i >= 0);
    downloadCsv(`${m.slug}-sample.csv`, lines.map((l) => keep.map((i) => l[i])));
  };
  return (
    <div className="mx-auto max-w-[640px] space-y-7">
      <input ref={input} type="file" accept={ACCEPT} className="hidden" data-slot="import-file-input"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}
        className={cn('rounded-[6px] border border-dashed px-6 py-9 text-center transition-colors', over ? 'border-primary bg-primary/5' : 'border-[#c9c9c9]')}
        data-slot="import-drop"
      >
        <span className="mx-auto mb-4 grid size-14 place-items-center rounded-full bg-white shadow-sm ring-1 ring-black/5"><Download className="size-5 text-muted-foreground" /></span>
        {loaded ? (
          <div className="space-y-2">
            <p className="text-[15px] font-medium" data-slot="import-file-name">{loaded.file.name}</p>
            <p className="text-[12.5px] text-muted-foreground">{loaded.body.length} row{loaded.body.length === 1 ? '' : 's'} and {loaded.headings.filter(Boolean).length} columns read</p>
            <div className="flex justify-center gap-4 text-[13px]">
              <button type="button" className="text-[#e85b4f] hover:underline" onClick={onRemove}>Remove</button>
              <button type="button" className="text-link hover:underline" onClick={() => input.current?.click()}>Replace File</button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-[15px]">Drag and drop file to import</p>
            <Button size="sm" className="mt-4" onClick={() => input.current?.click()} data-slot="import-choose">Choose File</Button>
          </>
        )}
        <p className="mt-4 text-[12px] text-muted-foreground">Maximum File Size: 25 MB • File Format: CSV or TSV or XLS</p>
      </div>

      <p className="text-[13px] leading-relaxed">
        Download a <button type="button" className="text-link hover:underline" onClick={sampleCsv} data-slot="sample-csv">sample csv file</button> or{' '}
        <button type="button" className="text-link hover:underline" onClick={() => downloadWorkbook(`${m.slug}-sample.xlsx`, templateSheets(m.kind))} data-slot="sample-xls">sample xls file</button>{' '}
        and compare it to your import file to ensure you have the file perfect for the import.
      </p>

      <div className="grid items-center gap-3 sm:grid-cols-[200px_1fr]">
        <label className="flex items-center gap-1.5 text-[13px]" htmlFor="import-encoding">
          Character Encoding
          <Tooltip>
            <TooltipTrigger aria-label="About character encoding"><HelpCircle className="size-3.5 text-muted-foreground" /></TooltipTrigger>
            <TooltipContent className="max-w-xs text-[12px]">How the file stores its letters. Excel and most programs save UTF-8; pick another only if names come out garbled. Excel files carry their own and ignore this.</TooltipContent>
          </Tooltip>
        </label>
        <div className="relative">
          <select id="import-encoding" value={encoding} onChange={(e) => onEncoding(e.target.value)}
            className="h-9 w-full appearance-none rounded-[4px] border bg-background px-3 pr-8 text-[13px]">
            {ENCODINGS.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        </div>
      </div>

      {m.duplicates && (
        <fieldset className="space-y-2" data-slot="import-duplicates">
          <legend className="mb-1 text-[13px] font-medium">Duplicate Handling</legend>
          {([['skip', 'Skip Duplicates', `${m.title} already in your books are left as they are; the rest are imported.`],
            ['error', 'Do not import if there are duplicates', `If any ${m.noun} is already in your books, the import stops and lists them.`]] as const).map(([v, label, note]) => (
            <label key={v} className="flex items-start gap-2.5 text-[13px]">
              <input type="radio" name="dup" className="mt-1" checked={onDuplicate === v} onChange={() => onDuplicateChange(v)} />
              <span><span className="font-medium">{label}</span><span className="block text-[12px] text-muted-foreground">{note}</span></span>
            </label>
          ))}
        </fieldset>
      )}

      <div className="rounded-[6px] bg-[#fdf8e7] p-4 text-[13px]" data-slot="import-tips">
        <p className="mb-2 flex items-center gap-1.5 font-medium"><Lightbulb className="size-4 text-amber-500" /> Page Tips</p>
        <ul className="list-disc space-y-1.5 pl-5 text-muted-foreground">
          <li>A file exported from Zoho Books imports as it is: its column headings are recognised.</li>
          <li>You can download the sample xls file to get detailed information about the data fields used while importing.</li>
          <li>If you have files in other formats, you can convert it to an accepted file format using any online/offline converter.</li>
          <li>Nothing is saved until the last step. The preview checks every row first, and an import keeps all its rows or none.</li>
        </ul>
      </div>
    </div>
  );
}

function MapFields({ m, fields, loaded, map, setMap, remember, setRemember, error }: {
  m: ImportModule; fields: ColumnSpec[]; loaded: Loaded; map: Record<string, string>; setMap: (v: Record<string, string>) => void;
  remember: boolean; setRemember: (v: boolean) => void; error: string | null;
}) {
  const heads = loaded.headings.filter(Boolean);
  return (
    <div className="mx-auto max-w-[820px] space-y-5" data-slot="import-map">
      <p className="text-[14px]">Your Selected File : <span className="font-semibold">{loaded.file.name}</span></p>
      <p className="flex items-center gap-2 rounded-[6px] bg-[#eef4fd] px-4 py-3 text-[13px]"><Info className="size-4 text-primary" /> The best match to each field on the selected file have been auto-selected.</p>
      {error && <p className="flex items-center gap-2 rounded-[6px] bg-[#fdecee] px-4 py-3 text-[13px] text-[#c0392b]" data-slot="import-map-error"><AlertTriangle className="size-4" /> {error}</p>}
      <section>
        <h2 className="mb-2 text-[14px] font-semibold">{m.noun[0].toUpperCase() + m.noun.slice(1)} Details</h2>
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="w-1/2 py-2 text-left font-medium">Rekonza Field</th>
              <th className="py-2 text-left font-medium">Imported File Headers</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.key} className="border-b last:border-0" data-slot={`map-row-${f.key}`}>
                <td className="py-2.5 pr-4 align-top">
                  <span className={f.required ? 'text-[#c0392b]' : ''}>{f.label}{f.required && ' *'}</span>
                  {f.hint && <span className="block text-[11.5px] text-muted-foreground">{f.hint}</span>}
                </td>
                <td className="py-2 align-top">
                  <div className="relative">
                    <select value={map[f.key] ?? ''} onChange={(e) => setMap({ ...map, [f.key]: e.target.value })}
                      className={cn('h-9 w-full appearance-none rounded-[4px] border bg-background px-3 pr-8 text-[13px]', f.required && !map[f.key] && 'border-[#e85b4f]')}
                      aria-label={f.label}>
                      <option value="">Select</option>
                      {heads.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Save these selections for use during future imports.
      </label>
    </div>
  );
}

function Preview({ m, rows, fields, unmapped, onDuplicate, canImport, onDone, onBack }: {
  m: ImportModule; rows: Record<string, string>[]; fields: ColumnSpec[]; unmapped: string[]; onDuplicate: 'skip' | 'error'; canImport: boolean;
  onDone: (created: number) => void; onBack: () => void;
}) {
  const router = useRouter();
  const [state, setState] = useState<{ kind: 'checking' } | { kind: 'checked'; r: ImportResponse } | { kind: 'demo' } | { kind: 'failed'; message: string }>({ kind: 'checking' });
  const [importing, setImporting] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({ errors: true });
  useEffect(() => {
    let live = true;
    imports.rows(m.kind, rows, { dryRun: true, onDuplicate })
      .then((r) => { if (live) setState({ kind: 'checked', r }); })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.code === 'demo_read_only') setState({ kind: 'demo' });
        else setState({ kind: 'failed', message: e instanceof Error ? e.message : String(e) });
      });
    return () => { live = false; };
  }, [m.kind, rows, onDuplicate]);

  // On the online demo the server cannot run the check; the file is still read and its blanks found here.
  const blanks = useMemo(() => rows.flatMap((r, i) => fields.filter((f) => f.required && !String(r[f.key] ?? '').trim()).map((f) => ({ row: Number(r.__line) || i + 2, message: `${f.label} is missing.` }))), [rows, fields]);

  const o = state.kind === 'checked' ? state.r.outcomes : [];
  const created = o.reduce((t, x) => t + x.created, 0);
  const skipped = o.reduce((t, x) => t + x.skipped, 0);
  const errors = state.kind === 'checked' ? o.flatMap((x) => x.errors) : state.kind === 'demo' ? blanks : [];
  const notes = o.flatMap((x) => x.notes);
  const ready = state.kind === 'checked' ? created : state.kind === 'demo' ? rows.length - new Set(blanks.map((b) => b.row)).size : 0;

  const run = async () => {
    if (state.kind === 'demo') {
      toast.info('The online demo does not keep anything.', { description: `In your own Rekonza book these ${ready} ${m.title.toLowerCase()} would be imported now.` });
      return;
    }
    setImporting(true);
    try {
      const r = await imports.rows(m.kind, rows, { dryRun: false, onDuplicate });
      if (r.committed) onDone(r.outcomes.reduce((t, x) => t + x.created, 0));
      else { setState({ kind: 'checked', r }); toast.error('Nothing was imported: some rows have problems.'); }
    } catch (e) {
      toast.error('The import did not run', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setImporting(false);
    }
  };

  const Row = ({ id, label, count, children }: { id: string; label: string; count: number; children?: React.ReactNode }) => (
    <div className="border-b py-3.5 last:border-0" data-slot={`preview-${id}`}>
      <div className="flex items-center justify-between gap-3 text-[13.5px]">
        <span>{label} - <span className="font-semibold">{count}</span></span>
        {children && count > 0 && (
          <button type="button" className="flex items-center gap-1 text-[13px] text-link hover:underline" onClick={() => setOpen({ ...open, [id]: !open[id] })}>
            {open[id] ? 'Hide Details' : 'View Details'} <ChevronDown className={cn('size-3.5 transition-transform', open[id] && 'rotate-180')} />
          </button>
        )}
      </div>
      {children && open[id] && count > 0 && <div className="mt-3">{children}</div>}
    </div>
  );

  const mapped = fields.filter((f) => rows.some((r) => String(r[f.key] ?? '').trim()));

  return (
    <>
      <div className="mx-auto mb-10 w-full max-w-[820px] space-y-5" data-slot="import-preview">
        {state.kind === 'checking' && (
          <p className="flex items-center gap-2 rounded-[6px] bg-muted/50 px-4 py-6 text-[13.5px]"><Loader2 className="size-4 animate-spin" /> Checking every row of the file against your books…</p>
        )}
        {state.kind === 'failed' && (
          <p className="flex items-start gap-2 rounded-[6px] bg-[#fdecee] px-4 py-3 text-[13px] text-[#c0392b]"><AlertTriangle className="mt-0.5 size-4 shrink-0" /> {state.message}</p>
        )}
        {state.kind === 'demo' && (
          <p className="flex items-start gap-2 rounded-[6px] bg-[#eef4fd] px-4 py-3 text-[13px]" data-slot="import-demo-note">
            <Info className="mt-0.5 size-4 shrink-0 text-primary" />
            This is the online demo, which keeps nothing, so the full check against your books runs in your own Rekonza book. Here the file is read and every mandatory field is checked.
          </p>
        )}
        {(state.kind === 'checked' || state.kind === 'demo') && (
          <>
            {errors.length === 0 ? (
              <p className="flex items-center gap-2 rounded-[6px] bg-[#e7f6ee] px-4 py-3 text-[13.5px] text-[#1e7a46]" data-slot="import-ready">
                <CheckCircle2 className="size-4" /> All {m.title} in your file are ready to be imported
              </p>
            ) : (
              <p className="flex items-center gap-2 rounded-[6px] bg-[#fdf3e2] px-4 py-3 text-[13.5px] text-[#8a5a00]" data-slot="import-problems">
                <AlertTriangle className="size-4" /> {errors.length} row{errors.length === 1 ? ' has a problem' : 's have problems'}. Fix {errors.length === 1 ? 'it' : 'them'} in the file and import it again; nothing is imported until every row is right.
              </p>
            )}
            <div className="rounded-[6px] border px-5">
              <Row id="ready" label={`${m.title} that are ready to be imported`} count={ready}>
                <div className="max-h-72 overflow-auto rounded border thin-scroll">
                  <table className="w-full text-[12px]">
                    <thead className="sticky top-0 bg-muted">
                      <tr>{mapped.slice(0, 8).map((f) => <th key={f.key} className="whitespace-nowrap px-2 py-1.5 text-left font-semibold">{f.label}</th>)}</tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, 50).map((r, i) => (
                        <tr key={i} className="border-t">{mapped.slice(0, 8).map((f) => <td key={f.key} className="whitespace-nowrap px-2 py-1">{r[f.key]}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {rows.length > 50 && <p className="mt-1 text-[12px] text-muted-foreground">The first 50 of {rows.length} rows.</p>}
              </Row>
              <Row id="skipped" label="No. of Records skipped" count={skipped}>
                <p className="text-[12.5px] text-muted-foreground">Already in your books: left as they are.</p>
              </Row>
              <Row id="unmapped" label="Unmapped Fields" count={unmapped.length}>
                <p className="text-[12.5px] text-muted-foreground">Not imported: {unmapped.map((u) => `"${u}"`).join(', ')}.</p>
              </Row>
              {errors.length > 0 && (
                <Row id="errors" label="Records with errors" count={errors.length}>
                  <ul className="max-h-72 space-y-1 overflow-auto text-[12.5px] thin-scroll" data-slot="import-errors">
                    {errors.slice(0, 300).map((e, i) => <li key={i}><span className="font-medium">Row {e.row}:</span> {e.message}</li>)}
                  </ul>
                </Row>
              )}
            </div>
            {notes.length > 0 && <ul className="list-disc space-y-1 pl-5 text-[12.5px] text-muted-foreground">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          </>
        )}
      </div>
      <footer className="sticky bottom-0 z-20 -mx-6 -mb-28 mt-auto flex items-center justify-between border-t bg-background px-6 py-3" data-slot="import-footer">
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="gap-1" onClick={onBack}><ChevronLeft className="size-3.5" /> Previous</Button>
          <Button size="sm" className="gap-1.5" onClick={() => void run()} data-slot="import-run"
            disabled={importing || !canImport || state.kind === 'checking' || state.kind === 'failed' || errors.length > 0 || ready === 0}>
            {importing && <Loader2 className="size-3.5 animate-spin" />} Import
          </Button>
        </div>
        <Button variant="outline" size="sm" onClick={() => router.push(m.back)}>Cancel</Button>
      </footer>
    </>
  );
}
