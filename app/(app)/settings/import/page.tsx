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
import { ArrowLeft, ArrowRight, Check, Download, FileSpreadsheet, Loader2, Upload } from 'lucide-react';
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
import { templateJson } from '@/lib/imports/json';
import { DELIMITERS, delimiterName, TEXT_FILE_TYPES } from '@/lib/delimited';
import { cellText, guessFileKind, readGrid } from '@/lib/imports/read-file';
import { takeHandedOver, type HandedOver } from '@/lib/imports/handover';
import { QuickBooksImport } from '@/components/quickbooks/file-import';
import { PdfInvoiceImport } from '@/components/imports/pdf-invoice-import';

const TABS = ['sheet', 'pdf', 'tally', 'quickbooks'] as const;
type Tab = (typeof TABS)[number];
/** A PDF or a photo of an invoice: read on the PDF tab, not as a sheet. */
const isPdfOrPhoto = (f: File) => /\.(pdf|png|jpe?g|webp)$/i.test(f.name) || /^(application\/pdf|image\/)/.test(f.type);

export default function ImportPage() {
  const [tab, setTab] = useState<Tab>('sheet');
  // PDFs handed to the PDF tab, which reads them at once; and those waiting
  // until it is opened, so none is read (with AI credits) unseen.
  const [pdfs, setPdfs] = useState<File[] | null>(null);
  const [pdfsWaiting, setPdfsWaiting] = useState<File[]>([]);
  // Spreadsheets handed to the sheet tab, which lines them up one after another.
  const [sheets, setSheets] = useState<File[] | null>(null);
  const [sheetsWaiting, setSheetsWaiting] = useState(0);

  /** Files chosen on another screen (the Tally tab, Tally → Import): each set to its own tab. */
  const receive = (h: HandedOver, open: Tab) => {
    if (h.sheets.length) setSheets(h.sheets);
    if (h.pdfs.length) {
      if (open === 'pdf') setPdfs(h.pdfs);
      else setPdfsWaiting((have) => [...have, ...h.pdfs]);
    }
    setTab(open);
  };
  // ?tab=pdf (or tally, quickbooks) opens that tab, as the sidebar's links do;
  // with any files Tally → Import passed on.
  useEffect(() => {
    const want = new URLSearchParams(window.location.search).get('tab');
    const open = want && (TABS as readonly string[]).includes(want) ? (want as Tab) : 'sheet';
    const handed = takeHandedOver();
    if (handed.sheets.length || handed.pdfs.length) receive(handed, open);
    else setTab(open);
  }, []);
  useEffect(() => {
    if (tab === 'pdf' && pdfsWaiting.length) { setPdfs(pdfsWaiting); setPdfsWaiting([]); }
  }, [tab, pdfsWaiting]);
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
        {tab === 'sheet' && pdfsWaiting.length > 0 && (
          <AlsoChosen what={`${pdfsWaiting.length} invoice${pdfsWaiting.length === 1 ? '' : 's'} to read`} where="Invoices from PDF" onOpen={() => setTab('pdf')} />
        )}
        {tab === 'pdf' && sheetsWaiting > 0 && (
          <AlsoChosen what={`${sheetsWaiting} spreadsheet${sheetsWaiting === 1 ? '' : 's'} to import`} where="Excel, CSV, text or JSON" onOpen={() => setTab('sheet')} />
        )}
        <TabsContent value="sheet" className="mt-4" keepMounted>
          <SheetImport incoming={sheets} onWaiting={setSheetsWaiting}
            onPdf={(files) => { setPdfs(files); setTab('pdf'); }}
            onPdfLater={(files) => setPdfsWaiting((have) => [...have, ...files])} />
        </TabsContent>
        <TabsContent value="pdf" className="mt-4" keepMounted><PdfInvoiceImport incoming={pdfs} /></TabsContent>
        <TabsContent value="quickbooks" className="mt-4"><QuickBooksImport /></TabsContent>
        <TabsContent value="tally" className="mt-4 space-y-6"><TallyFileImport onOtherFiles={receive} /><TallyImport /></TabsContent>
      </Tabs>
    </>
  );
}

/** Files chosen elsewhere are waiting on this tab: say so, with the way there. */
function AlsoChosen({ what, where, onOpen }: { what: string; where: string; onOpen: () => void }) {
  return (
    <p className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100" data-slot="import-also-chosen">
      Also chosen: {what}, on the <span className="font-medium">{where}</span> tab.
      <Button size="xs" variant="outline" className="ml-auto gap-1" onClick={onOpen}>Open it <ArrowRight className="size-3" /></Button>
    </p>
  );
}

/** A file lined up on the sheet tab, with the import its headings are for. */
interface Lined { file: File; kind: ImportKind | null; imported: boolean }

function SheetImport({ incoming, onWaiting, onPdf, onPdfLater }: {
  /** Spreadsheets chosen on another screen: lined up, the first opened. */
  incoming: File[] | null;
  /** How many lined-up files are still to import, for the other tabs to mention. */
  onWaiting: (n: number) => void;
  /** Only PDFs (or photos) chosen here: read them on their own tab. */
  onPdf: (files: File[]) => void;
  /** PDFs chosen along with spreadsheets: kept for the PDF tab. */
  onPdfLater: (files: File[]) => void;
}) {
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
  // Several files at once: each opens in turn, set to its own import.
  const [lined, setLined] = useState<Lined[]>([]);
  const [openFile, setOpenFile] = useState<File | null>(null);
  const t = TEMPLATES[kind];

  const missing = useMemo(
    () => t.columns.filter((c) => c.required && !headings.some((h) => h.key === c.key)).map((c) => c.label),
    [t, headings],
  );

  const reset = (k: ImportKind) => { setKind(k); setRows([]); setHeadings([]); setFileName(''); setResult(null); setOpenFile(null); };

  /**
   * Read a file under an import. `findKind`: when that import misses a column
   * the file needs and another import takes the file whole, read it as that one.
   */
  const load = async (file: File | undefined | null, chosen = sep === 'other' ? otherSep : sep, k: ImportKind = kind, findKind = false): Promise<void> => {
    if (!file) return;
    setResult(null);
    setReadWith(null);
    try {
      const { grid, delimiter } = await readGrid(file, k, chosen);
      if (delimiter) { setReadWith(delimiter); setLastFile(file); }
      if (grid.length < 2) throw new Error('The file needs a row of headings and at least one row under it.');
      const map = grid[0].map((h, idx) => ({ heading: cellText(h).trim(), key: columnFor(k, cellText(h)), idx }));
      const lacking = TEMPLATES[k].columns.some((c) => c.required && !map.some((m) => m.key === c.key));
      if (findKind && lacking) {
        const better = await guessFileKind(file);
        if (better && better !== k) {
          toast.info(`Read as ${TEMPLATES[better].title}`, { description: `${file.name} has the columns of ${TEMPLATES[better].title.toLowerCase()}, not of ${TEMPLATES[k].title.toLowerCase()}.` });
          return await load(file, chosen, better, false);
        }
      }
      const body = grid.slice(1)
        .filter((r) => r.some((c) => cellText(c).trim() !== ''))
        .map((r) => Object.fromEntries(map.filter((m) => m.key).map((m) => [m.key!, cellText(r[m.idx]).trim()])));
      if (body.length > MAX_IMPORT_ROWS) throw new Error(`The file has ${body.length} rows; import up to ${MAX_IMPORT_ROWS} at a time.`);
      setKind(k);
      setHeadings(map);
      setRows(body);
      setFileName(file.name);
      setOpenFile(file);
    } catch (e) {
      toast.error('Could not read that file', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      if (input.current) input.current.value = '';
    }
  };

  /** Several files: lined up, each set to the import its headings are for, and the first opened. */
  const lineUp = async (files: File[]) => {
    const guessed: Lined[] = await Promise.all(files.map(async (file) => ({ file, kind: await guessFileKind(file), imported: false })));
    setLined((have) => [...have.filter((h) => !guessed.some((g) => g.file.name === h.file.name)), ...guessed]);
    const first = guessed[0];
    if (first) await load(first.file, sep === 'other' ? otherSep : sep, first.kind ?? kind, !first.kind);
  };
  // Only a new hand-over lines files up; the reader and the callback are the same each time.
  useEffect(() => {
    if (incoming?.length) void lineUp(incoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming]);
  useEffect(() => {
    onWaiting(lined.filter((l) => !l.imported).length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lined]);
  const nextUp = lined.find((l) => !l.imported && l.file !== openFile);
  const openLined = (l: Lined) => void load(l.file, sep === 'other' ? otherSep : sep, l.kind ?? kind, !l.kind);

  const run = async (dryRun: boolean) => {
    setBusy(dryRun ? 'check' : 'import');
    try {
      const r = await imports.rows(kind, rows, { dryRun, onDuplicate });
      setResult(r);
      if (r.committed) {
        toast.success(`${t.title} imported`);
        setLined((have) => have.map((l) => (l.file === openFile ? { ...l, imported: true } : l)));
      }
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
        {lined.length > 0 && (
          <Card className="space-y-2 border-t-4 border-t-blue-500 p-4" data-slot="sheet-lined">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold">Files to import, one after another</p>
              {nextUp && (
                <Button size="sm" className="gap-1.5" data-slot="sheet-next" onClick={() => openLined(nextUp)}>
                  Next: {nextUp.file.name} <ArrowRight className="size-3.5" />
                </Button>
              )}
            </div>
            <ul className="space-y-1">
              {lined.map((l) => (
                <li key={l.file.name} data-slot="sheet-lined-file" data-imported={l.imported || undefined}
                  className={`flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs ${l.file === openFile ? 'border-primary/50 bg-primary/5' : 'bg-muted/30'}`}>
                  {l.imported ? <Check className="size-3.5 text-emerald-600" /> : <FileSpreadsheet className="size-3.5 text-muted-foreground" />}
                  <button type="button" className="min-w-0 flex-1 truncate text-left font-medium hover:underline" onClick={() => openLined(l)}>
                    {l.file.name}
                  </button>
                  <span className="text-muted-foreground">
                    {l.kind ? TEMPLATES[l.kind].title : 'pick its import on the left'}
                    {l.imported ? ' · imported' : l.file === openFile ? ' · open below' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
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
                const pdfs = files.filter(isPdfOrPhoto);
                const sheets = files.filter((f) => !isPdfOrPhoto(f));
                if (pdfs.length) onPdfLater(pdfs);
                // One file: under the import chosen, or the one it fits if that cannot take it. More: lined up.
                if (sheets.length > 1) void lineUp(sheets);
                else void load(sheets[0], undefined, kind, true);
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
