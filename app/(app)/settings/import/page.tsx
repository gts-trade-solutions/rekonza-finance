'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Bringing data in: from a spreadsheet, CSV or any delimited text file (tab,
// pipe, semicolon…), JSON, or a whole company from Tally or QuickBooks.
//
// Every import is checked first. The check does the whole import and throws it
// away, so what it reports is exactly what the real run will do; the real run
// keeps everything or nothing.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import Papa from 'papaparse';
import { ArrowLeft, Download, FileSpreadsheet, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/shared/page-header';
import { downloadCsv, downloadJson } from '@/components/shared/report-shell';
import { api, imports, type ImportResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { columnFor, IMPORT_KINDS, MAX_IMPORT_ROWS, TEMPLATES, templateCsv, templateSheets, type ImportKind } from '@/lib/imports/templates';
import { downloadWorkbook } from '@/lib/xlsx';
import { Outcomes } from '@/components/shared/import-outcomes';
import { TallyFileImport } from '@/components/tally/file-import';
import { jsonGrid, templateJson } from '@/lib/imports/json';
import { DELIMITERS, delimiterName, guessDelimiter, readTextFile, TEXT_FILE_TYPES } from '@/lib/delimited';
import { QuickBooksImport } from '@/components/quickbooks/file-import';
import { PdfInvoiceImport } from '@/components/imports/pdf-invoice-import';

const TABS = ['sheet', 'pdf', 'tally', 'quickbooks'] as const;
type Tab = (typeof TABS)[number];
/** A PDF or a photo of an invoice: read on the PDF tab, not as a sheet. */
const isPdfOrPhoto = (f: File) => /\.(pdf|png|jpe?g|webp)$/i.test(f.name) || /^(application\/pdf|image\/)/.test(f.type);

/** A cell as text the server reads: dates as yyyy-mm-dd. */
const cellText = (v: unknown) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : v === null || v === undefined ? '' : String(v);

export default function ImportPage() {
  const [tab, setTab] = useState<Tab>('sheet');
  // PDFs chosen on the spreadsheet tab, handed to the PDF tab.
  const [pdfs, setPdfs] = useState<File[] | null>(null);
  // ?tab=pdf (or tally, quickbooks) opens that tab, as the sidebar's links do.
  useEffect(() => {
    const want = new URLSearchParams(window.location.search).get('tab');
    if (want && (TABS as readonly string[]).includes(want)) setTab(want as Tab);
  }, []);
  return (
    <>
      <PageHeader
        title="Import"
        description="Bring masters, opening balances and vouchers in from Excel, CSV, text (tab, pipe or any separator) or JSON, invoices from PDF, or a whole company from Tally or QuickBooks."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/settings"><ArrowLeft className="mr-1.5 size-3.5" /> Settings</Link>
          </Button>
        }
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className="max-w-full flex-wrap group-data-[orientation=horizontal]/tabs:h-auto">
          <TabsTrigger value="sheet">Excel, CSV, text or JSON</TabsTrigger>
          <TabsTrigger value="pdf" data-slot="import-tab-pdf">Invoices from PDF</TabsTrigger>
          <TabsTrigger value="tally">From Tally</TabsTrigger>
          <TabsTrigger value="quickbooks">From QuickBooks</TabsTrigger>
        </TabsList>
        <TabsContent value="sheet" className="mt-4"><SheetImport onPdf={(files) => { setPdfs(files); setTab('pdf'); }} /></TabsContent>
        <TabsContent value="pdf" className="mt-4" keepMounted><PdfInvoiceImport incoming={pdfs} /></TabsContent>
        <TabsContent value="quickbooks" className="mt-4"><QuickBooksImport /></TabsContent>
        <TabsContent value="tally" className="mt-4 space-y-6"><TallyFileImport /><TallyImport /></TabsContent>
      </Tabs>
    </>
  );
}

function SheetImport({ onPdf }: { onPdf: (files: File[]) => void }) {
  const [kind, setKind] = useState<ImportKind>('contacts');
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [headings, setHeadings] = useState<{ heading: string; key: string | null }[]>([]);
  const [fileName, setFileName] = useState('');
  const [onDuplicate, setOnDuplicate] = useState<'skip' | 'error'>('skip');
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [busy, setBusy] = useState<false | 'check' | 'import'>(false);
  const input = useRef<HTMLInputElement>(null);
  // For a text file: the separator, found by itself unless one is chosen; and the file, to read again with another.
  const [sep, setSep] = useState<string>('auto');
  const [otherSep, setOtherSep] = useState('');
  const [readWith, setReadWith] = useState<string | null>(null);
  const [lastFile, setLastFile] = useState<File | null>(null);
  const t = TEMPLATES[kind];

  const missing = useMemo(
    () => t.columns.filter((c) => c.required && !headings.some((h) => h.key === c.key)).map((c) => c.label),
    [t, headings],
  );

  const reset = (k: ImportKind) => { setKind(k); setRows([]); setHeadings([]); setFileName(''); setResult(null); };

  const load = async (file: File | undefined | null, chosen = sep === 'other' ? otherSep : sep) => {
    if (!file) return;
    setResult(null);
    setReadWith(null);
    try {
      let grid: unknown[][];
      if (/\.xlsx$/i.test(file.name)) {
        const { default: readXlsxFile } = await import('read-excel-file/browser');
        const sheets = (await readXlsxFile(file)) as unknown as { sheet: string; data: unknown[][] }[];
        grid = sheets.find((s) => s.data.some((r) => r.some((c) => c !== null && c !== '')))?.data ?? [];
      } else if (/\.json$/i.test(file.name)) {
        // The same grid a spreadsheet gives (lib/imports/json.ts).
        grid = jsonGrid(await file.text(), kind);
      } else {
        // CSV or any delimited text: comma, tab, pipe, semicolon, or a separator of the user's own.
        const text = await readTextFile(file);
        const delimiter = chosen === 'auto' || !chosen ? guessDelimiter(text) : chosen;
        grid = Papa.parse<string[]>(text, { delimiter, skipEmptyLines: 'greedy' }).data;
        setReadWith(delimiter);
        setLastFile(file);
      }
      if (grid.length < 2) throw new Error('The file needs a row of headings and at least one row under it.');
      const map = grid[0].map((h, idx) => ({ heading: cellText(h).trim(), key: columnFor(kind, cellText(h)), idx }));
      const body = grid.slice(1)
        .filter((r) => r.some((c) => cellText(c).trim() !== ''))
        .map((r) => Object.fromEntries(map.filter((m) => m.key).map((m) => [m.key!, cellText(r[m.idx]).trim()])));
      if (body.length > MAX_IMPORT_ROWS) throw new Error(`The file has ${body.length} rows; import up to ${MAX_IMPORT_ROWS} at a time.`);
      setHeadings(map);
      setRows(body);
      setFileName(file.name);
    } catch (e) {
      toast.error('Could not read that file', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      if (input.current) input.current.value = '';
    }
  };

  const run = async (dryRun: boolean) => {
    setBusy(dryRun ? 'check' : 'import');
    try {
      const r = await imports.rows(kind, rows, { dryRun, onDuplicate });
      setResult(r);
      if (r.committed) toast.success(`${t.title} imported`);
    } catch (e) {
      toast.error('The import did not run', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const checked = result && !result.committed && result.outcomes.every((o) => o.errors.length === 0);

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
      <Card className="h-fit p-2">
        {IMPORT_KINDS.map((k) => (
          <button key={k} type="button" onClick={() => reset(k)}
            className={`block w-full rounded-md px-3 py-2 text-left text-sm ${k === kind ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-accent'}`}>
            {TEMPLATES[k].title}
          </button>
        ))}
      </Card>
      <div className="space-y-4">
        <Card className="space-y-3 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">{t.title}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{t.description}</p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => downloadWorkbook(`rekonza-${kind}-template.xlsx`, templateSheets(kind))}>
                <Download className="size-3.5" /> Excel template
              </Button>
              <Button size="sm" variant="ghost" onClick={() => {
                const lines = templateCsv(kind).split('\n').map((l) => Papa.parse<string[]>(l).data[0]);
                downloadCsv(`rekonza-${kind}-template.csv`, lines);
              }}>
                CSV
              </Button>
              <Button size="sm" variant="ghost" onClick={() => downloadJson(`rekonza-${kind}-template.json`, templateJson(kind))}>
                JSON
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs" data-slot="sheet-separator">
            <span className="text-muted-foreground">Text files, separated by</span>
            <select className="h-8 rounded-md border bg-background px-2 text-xs" value={sep} aria-label="Separator"
              onChange={(e) => { setSep(e.target.value); if (e.target.value !== 'other') void load(lastFile, e.target.value); }}>
              <option value="auto">Find it by itself</option>
              {DELIMITERS.map((d) => <option key={d.key} value={d.char}>{d.label}</option>)}
              <option value="other">Another character</option>
            </select>
            {sep === 'other' && (
              <input value={otherSep} maxLength={1} placeholder="~" aria-label="Separator character"
                className="h-8 w-12 rounded-md border bg-background px-2 text-center font-mono text-xs"
                onChange={(e) => { setOtherSep(e.target.value); if (e.target.value) void load(lastFile, e.target.value); }} />
            )}
            <span className="text-muted-foreground">· .csv, .txt, .tsv, .dsv, .psv; UTF-8 or Excel&apos;s Unicode text</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {t.columns.map((c) => (
              <Badge key={c.key} variant={c.required ? 'default' : 'outline'} className="text-[10px]" title={c.hint}>{c.label}</Badge>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <input ref={input} type="file" accept={`${TEXT_FILE_TYPES},.xlsx,.json,application/json,.pdf,application/pdf`} multiple className="hidden" data-slot="sheet-file-input"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                // Invoices as PDFs (or photos) are read on their own tab, by the AI.
                if (files.length && files.every(isPdfOrPhoto)) { e.target.value = ''; onPdf(files); return; }
                void load(files.find((f) => !isPdfOrPhoto(f)));
              }} />
            <Button size="sm" className="gap-1.5" onClick={() => input.current?.click()}>
              <Upload className="size-3.5" /> Choose an Excel, CSV, text, JSON or PDF file
            </Button>
            {fileName && <span className="text-xs text-muted-foreground" data-slot="sheet-file-read"><FileSpreadsheet className="mr-1 inline size-3.5" />{fileName}: {rows.length} row(s){readWith ? `, separated by ${delimiterName(readWith).toLowerCase()}` : ''}</span>}
            {['contacts', 'items', 'accounts'].includes(kind) && (
              <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                Already in the books:
                <select className="h-8 rounded-md border bg-background px-2 text-xs" value={onDuplicate} onChange={(e) => setOnDuplicate(e.target.value as 'skip' | 'error')}>
                  <option value="skip">leave it</option>
                  <option value="error">count it as a problem</option>
                </select>
              </label>
            )}
          </div>
        </Card>

        {rows.length > 0 && (
          <Card className="space-y-3 p-5">
            {headings.some((h) => !h.key) && (
              <p className="text-xs text-muted-foreground">
                Not used: {headings.filter((h) => !h.key).map((h) => `"${h.heading}"`).join(', ')}.
              </p>
            )}
            {missing.length > 0 && (
              <p className="text-sm text-destructive">The file has no column for {missing.join(', ')}.</p>
            )}
            <div className="max-h-64 overflow-auto rounded-md border thin-scroll">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-2 py-1.5 text-left font-semibold text-muted-foreground">Row</th>
                    {t.columns.filter((c) => headings.some((h) => h.key === c.key)).map((c) => (
                      <th key={c.key} className="whitespace-nowrap px-2 py-1.5 text-left font-semibold text-muted-foreground">{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 20).map((r, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="px-2 py-1 text-muted-foreground">{i + 2}</td>
                      {t.columns.filter((c) => headings.some((h) => h.key === c.key)).map((c) => (
                        <td key={c.key} className="whitespace-nowrap px-2 py-1">{r[c.key]}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > 20 && <p className="text-xs text-muted-foreground">Showing the first 20 of {rows.length}.</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => void run(true)} disabled={!!busy || missing.length > 0} className="gap-1.5">
                {busy === 'check' && <Loader2 className="size-4 animate-spin" />} Check
              </Button>
              <Button onClick={() => void run(false)} disabled={!!busy || !checked} className="gap-1.5">
                {busy === 'import' && <Loader2 className="size-4 animate-spin" />} Import {rows.length} row(s)
              </Button>
            </div>
          </Card>
        )}

        {result && <Outcomes result={result} />}
      </div>
    </div>
  );
}

function TallyImport() {
  const companies = useApi(
    () => api.get<{ companies: { id: string; name: string; asOf: string | null; ledgers: number; stockItems: number }[] }>('/api/tally')
      .catch(() => ({ companies: [] })),
    [],
  );
  const [source, setSource] = useState<{ kind: 'company'; id: string; name: string } | null>(null);
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [busy, setBusy] = useState<false | 'check' | 'import'>(false);

  const run = async (dryRun: boolean) => {
    if (!source) return;
    setBusy(dryRun ? 'check' : 'import');
    try {
      const r = await imports.tallyCompany(source.id, dryRun);
      setResult(r);
      if (r.committed) toast.success(`${source.name} brought in`);
    } catch (e) {
      toast.error('The import did not run', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const checked = result && !result.committed && result.outcomes.every((o) => o.errors.length === 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-4">
        <Card className="space-y-3 p-5">
          <p className="text-sm font-medium">A connected Tally company</p>
          <p className="text-xs text-muted-foreground">Uses the balances at the end of the period the connector last read.</p>
          {(companies.data?.companies ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">No company connected. <Link href="/tally" className="underline">Connect Tally</Link>.</p>
          ) : (
            <div className="space-y-1.5">
              {companies.data!.companies.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="tally-company" checked={source?.kind === 'company' && source.id === c.id}
                    onChange={() => { setResult(null); setSource({ kind: 'company', id: c.id, name: c.name }); }} />
                  {c.name}
                  <span className="text-xs text-muted-foreground">{c.ledgers} ledgers, {c.stockItems} items{c.asOf ? `, to ${c.asOf}` : ''}</span>
                </label>
              ))}
            </div>
          )}
        </Card>
      </div>
      {source && (
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => void run(true)} disabled={!!busy} className="gap-1.5">
            {busy === 'check' && <Loader2 className="size-4 animate-spin" />} Check
          </Button>
          <Button onClick={() => void run(false)} disabled={!!busy || !checked} className="gap-1.5">
            {busy === 'import' && <Loader2 className="size-4 animate-spin" />} Bring it in
          </Button>
        </div>
      )}
      {result && <Outcomes result={result} />}
      {(companies.data?.companies ?? []).length > 0 && <TallyVouchers companies={companies.data!.companies} />}
    </div>
  );
}

/**
 * After the masters: the company's vouchers, posted here as journal entries.
 * Run it again later and only what is new comes across.
 */
function TallyVouchers({ companies }: { companies: { id: string; name: string }[] }) {
  const [companyId, setCompanyId] = useState(companies[0]?.id ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [busy, setBusy] = useState<false | 'check' | 'import'>(false);
  const run = async (dryRun: boolean) => {
    setBusy(dryRun ? 'check' : 'import');
    try {
      const r = await imports.tallyVouchers(companyId, from || null, to || null, dryRun);
      setResult(r);
      if (r.committed) toast.success(`${r.outcomes[0]?.created ?? 0} voucher(s) posted`);
    } catch (e) {
      toast.error('The import did not run', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const checked = result && !result.committed && result.outcomes.every((o) => o.errors.length === 0);
  return (
    <Card className="space-y-3 p-5">
      <div>
        <p className="text-sm font-medium">Vouchers from a connected company</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Once the masters are across, every voucher the connector has read from the day these books start comes across
          as a journal entry, with its Tally type, number and narration — so the ledgers and statements carry on where Tally
          left off. They are not invoices, so they do not enter the GST returns: bring across periods whose returns Tally
          already filed. Running it again brings only vouchers not yet posted.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">Company</span>
          <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={companyId} onChange={(e) => { setCompanyId(e.target.value); setResult(null); }}>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs"><span className="text-muted-foreground">From (optional)</span>
          <input type="date" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={from} onChange={(e) => { setFrom(e.target.value); setResult(null); }} />
        </label>
        <label className="space-y-1 text-xs"><span className="text-muted-foreground">To (optional)</span>
          <input type="date" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={to} onChange={(e) => { setTo(e.target.value); setResult(null); }} />
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => void run(true)} disabled={!!busy || !companyId} className="gap-1.5">
          {busy === 'check' && <Loader2 className="size-4 animate-spin" />} Check
        </Button>
        <Button onClick={() => void run(false)} disabled={!!busy || !checked} className="gap-1.5">
          {busy === 'import' && <Loader2 className="size-4 animate-spin" />} Post the vouchers
        </Button>
      </div>
      {result && <Outcomes result={result} />}
    </Card>
  );
}
