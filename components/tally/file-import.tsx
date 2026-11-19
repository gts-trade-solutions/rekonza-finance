'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Import from Tally files: the XML TallyPrime (or Tally.ERP 9) exports, loose
// or zipped. Tally's own data folder (Company.900, TranMgr.900…) is recognised
// too, and answered with how to bring that company across (lib/tally/data-files).
//
// Any other file chosen here (a customer list, an invoice PDF) is not refused:
// it is named for what it is and passed on to the import that reads it.
//
// One upload may carry the masters, the vouchers, or both, in one file or a
// few. What the files hold is read here in the browser and shown before
// anything is sent; then a check runs the whole import on the server and
// throws it away, and only a clean check can be brought in for real. Running
// the same files again adds only what is new.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Database, Download, FileCode2, FileSpreadsheet, FileText, Loader2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Outcomes } from '@/components/shared/import-outcomes';
import { formatINR } from '@/lib/money';
import { dayLabel } from '@/lib/date-range';
import { imports, type ImportResponse } from '@/lib/api/client';
import { usePermission } from '@/lib/store/hooks';
import { parseTallyFiles, readTallyFile, summariseTallyFile } from '@/lib/tally/xml';
import { tallySampleXml } from '@/lib/tally/sample';
import { isTallyDataFile, isTallyExportFile, unzipEntry, zipEntries } from '@/lib/tally/data-files';
import { fileHome, type FileHome } from '@/lib/imports/file-kind';
import { guessFileKind } from '@/lib/imports/read-file';
import { handOver, type HandedOver } from '@/lib/imports/handover';
import { TEMPLATES, type ImportKind } from '@/lib/imports/templates';

/**
 * What the file picker offers: Tally's XML, zips of it, Tally's data files (to
 * explain them), and the files Import reads, to pass on to it.
 */
const ACCEPT = [
  '.xml,text/xml,application/xml,.txt,.zip,application/zip,.900,.1800,.tsf,.001',
  '.xlsx,.csv,.tsv,.dsv,.psv,text/csv,.json,application/json,.pdf,application/pdf,image/png,image/jpeg,image/webp,.iif',
].join(',');
const baseName = (n: string) => n.split(/[\\/]/).pop() ?? n;

/** What the server's nginx and the app let through in one request. */
const MAX_UPLOAD = 24 * 1024 * 1024;

interface Picked { name: string; size: number; xml: string }

/** A file chosen here that another import reads: what it is, and for a sheet, which import its headings fit. */
interface Other { file: File; home: Exclude<FileHome, 'tally' | 'tally-data' | 'zip'>; kind: ImportKind | null }

/** Spreadsheets first, then invoices, then the rest; each in the order of their names (1-, 2-, … 10-). */
const HOME_ORDER: Other['home'][] = ['sheet', 'pdf', 'quickbooks', 'unreadable'];
const inOrder = (a: Other, b: Other) =>
  HOME_ORDER.indexOf(a.home) - HOME_ORDER.indexOf(b.home) || a.file.name.localeCompare(b.file.name, undefined, { numeric: true });

const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

function downloadSample() {
  const blob = new Blob([tallySampleXml(today())], { type: 'application/xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tally-sample-${today()}.xml`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function TallyFileImport({ onOtherFiles }: {
  /** On Settings → Import: open the other files on that page's own tabs. Elsewhere they are taken there. */
  onOtherFiles?: (files: HandedOver, open: 'sheet' | 'pdf') => void;
} = {}) {
  const router = useRouter();
  const canBooks = usePermission('accountant', 'create');
  const canSales = usePermission('sales', 'create');
  const canImport = canBooks && canSales;
  const [files, setFiles] = useState<Picked[]>([]);
  const [reading, setReading] = useState(false);
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [busy, setBusy] = useState<false | 'check' | 'import'>(false);
  /** Tally data files chosen (Company.900…): not read, only explained. */
  const [dataFiles, setDataFiles] = useState<string[]>([]);
  /** Spreadsheets, invoice PDFs and the like: for Import, not for here. */
  const [others, setOthers] = useState<Other[]>([]);
  const input = useRef<HTMLInputElement>(null);

  const summary = useMemo(() => (files.length ? summariseTallyFile(parseTallyFiles(files.map((f) => f.xml))) : null), [files]);
  const bytes = files.reduce((t, f) => t + new Blob([f.xml]).size, 0);
  const tooBig = bytes > MAX_UPLOAD;
  const empty = !!summary && !summary.ledgers && !summary.stockItems && !summary.vouchers;

  const add = async (list: FileList | null) => {
    if (!list?.length) return;
    setReading(true);
    try {
      const read: Picked[] = [];
      const found: string[] = [];
      const nothingInside: string[] = [];
      const other: Other[] = [];
      for (const f of [...list]) {
        // A .txt is told by what is in it: Tally writes XML to .txt as well.
        const home = /\.txt$/i.test(f.name) ? null : fileHome(f.name);
        if (home === 'tally-data') {
          found.push(baseName(f.name));
          continue;
        }
        if (home && home !== 'tally' && home !== 'zip') {
          other.push({ file: f, home, kind: home === 'sheet' ? await guessFileKind(f) : null });
          continue;
        }
        if (home === 'zip') {
          const entries = await zipEntries(f);
          const data = entries.filter((e) => isTallyDataFile(e.name));
          const xmls = entries.filter((e) => isTallyExportFile(e.name));
          found.push(...data.map((e) => baseName(e.name)));
          for (const e of xmls) {
            read.push({ name: `${f.name} › ${baseName(e.name)}`, size: e.size, xml: await readTallyFile(new Blob([(await unzipEntry(f, e)) as BlobPart])) });
          }
          if (!data.length && !xmls.length) nothingInside.push(f.name);
          continue;
        }
        const xml = await readTallyFile(f);
        if (fileHome(f.name, xml.slice(0, 200)) === 'sheet') {
          other.push({ file: f, home: 'sheet', kind: await guessFileKind(f) });
          continue;
        }
        read.push({ name: f.name, size: f.size, xml });
      }
      if (read.length) {
        setFiles((have) => [...have.filter((h) => !read.some((r) => r.name === h.name)), ...read]);
        setResult(null);
      }
      if (found.length) setDataFiles((have) => [...new Set([...have, ...found])]);
      if (other.length) {
        setOthers((have) => [...have.filter((h) => !other.some((o) => o.file.name === h.file.name)), ...other]
          .sort(inOrder));
      }
      if (nothingInside.length) {
        toast.error(`No Tally files in ${nothingInside.join(', ')}`, { description: 'A zip should hold the XML files Tally exported, or a Tally company folder.' });
      }
    } catch (e) {
      toast.error('That file could not be read', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setReading(false);
      if (input.current) input.current.value = '';
    }
  };

  const run = async (dryRun: boolean) => {
    setBusy(dryRun ? 'check' : 'import');
    try {
      const r = await imports.tallyFiles(files.map((f) => f.xml), dryRun);
      setResult(r);
      if (r.committed) toast.success('Brought in from Tally');
    } catch (e) {
      toast.error('The import did not run', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const checked = !!result && !result.committed && result.outcomes.every((o) => o.errors.length === 0);

  /** The other files, to the import that reads them: on this page's tabs, or on Settings → Import. */
  const passOn = (open: 'sheet' | 'pdf') => {
    const files: HandedOver = {
      sheets: others.filter((o) => o.home === 'sheet').map((o) => o.file),
      pdfs: others.filter((o) => o.home === 'pdf').map((o) => o.file),
    };
    setOthers([]);
    if (onOtherFiles) onOtherFiles(files, open);
    else { handOver(files); router.push(`/settings/import?tab=${open}`); }
  };

  return (
    <div className="space-y-4" data-slot="tally-file-import">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-3 border-t-4 border-t-amber-500 p-5">
          <p className="text-sm font-semibold">1 · Export from Tally</p>
          <ol className="list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-muted-foreground">
            <li><span className="font-medium text-foreground">Masters</span> (ledgers, groups, stock items, with their opening balances and unpaid bills): in TallyPrime, press <kbd className="rounded border bg-muted px-1">Alt+E</kbd> Export → <em>Masters</em> → <em>All Masters</em>, format <em>XML (Data Interchange)</em>, and export.</li>
            <li><span className="font-medium text-foreground">Vouchers</span> (sales, purchases, receipts, payments, contra, journals): open the <em>Day Book</em>, set the period with <kbd className="rounded border bg-muted px-1">F2</kbd>, then <kbd className="rounded border bg-muted px-1">Alt+E</kbd> Export → <em>Current</em>, format <em>XML (Data Interchange)</em>.</li>
            <li>Tally.ERP 9: the same from <em>Display → Day Book</em> and <em>Display → List of Accounts</em>, with <kbd className="rounded border bg-muted px-1">Alt+E</kbd>.</li>
          </ol>
          <p className="text-xs text-muted-foreground">
            Bring the masters first, or both files together. A big Day Book can go a quarter at a time: importing the same voucher twice never enters it twice.
          </p>
        </Card>

        <Card className="space-y-3 border-t-4 border-t-blue-500 p-5">
          <p className="text-sm font-semibold">2 · Choose the files</p>
          <p className="text-xs text-muted-foreground">One or more .xml files Tally exported (masters, vouchers, or both), or a .zip of them. They are read here first; nothing is saved until you bring them in. Tally&apos;s own data files (Company.900 and the rest) are recognised too, and a spreadsheet, CSV, JSON or invoice PDF chosen here is passed to the import that reads it.</p>
          <input ref={input} type="file" accept={ACCEPT} multiple className="hidden" data-slot="tally-file-input"
            onChange={(e) => void add(e.target.files)} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" className="gap-1.5" onClick={() => input.current?.click()} disabled={reading} data-slot="tally-choose-files">
              {reading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} Choose Tally files
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={downloadSample} data-slot="tally-sample">
              <Download className="size-3.5" /> Sample Tally file
            </Button>
          </div>
          {files.length > 0 && (
            <ul className="space-y-1">
              {files.map((f) => (
                <li key={f.name} className="flex items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5 text-xs">
                  <FileCode2 className="size-3.5 shrink-0 text-amber-600" />
                  <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
                  <span className="text-muted-foreground">{(f.size / 1024).toFixed(0)} KB</span>
                  <button type="button" aria-label={`Remove ${f.name}`} className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                    onClick={() => { setFiles((have) => have.filter((h) => h.name !== f.name)); setResult(null); }}>
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {dataFiles.length > 0 && <DataFilesHelp names={dataFiles} onClear={() => setDataFiles([])} />}

      {others.length > 0 && <OtherFiles files={others} onOpen={passOn} onClear={() => setOthers([])} />}

      {summary && (
        <Card className="space-y-4 border-t-4 border-t-emerald-500 p-5" data-slot="tally-file-summary">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-semibold">3 · What the {files.length === 1 ? 'file holds' : `${files.length} files hold`}</p>
            {summary.company && <p className="text-xs text-muted-foreground">Tally company: <span className="font-medium text-foreground">{summary.company}</span></p>}
          </div>
          {empty ? (
            <p className="text-sm text-destructive">No ledgers, stock items or vouchers were found. Export again from Tally with the format set to XML (Data Interchange).</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Figure label="Ledgers" value={summary.ledgers} sub={summary.parties ? `${summary.parties} customers and vendors` : 'no parties'} />
                <Figure label="Groups" value={summary.groups} sub="of your own, under Tally's" />
                <Figure label="Stock items" value={summary.stockItems} sub="become items, with opening stock" />
                <Figure label="Vouchers to post" value={summary.posting}
                  sub={summary.from ? `${dayLabel(summary.from)} to ${dayLabel(summary.to!)}` : 'none in the file'} />
              </div>
              {summary.byType.length > 0 && (
                <div className="overflow-hidden rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="bg-table-head text-table-head-foreground">
                      <tr><th className="px-3 py-2 text-left text-xs font-semibold">Voucher type</th><th className="px-3 py-2 text-right text-xs font-semibold">Vouchers</th><th className="px-3 py-2 text-right text-xs font-semibold">Amount</th></tr>
                    </thead>
                    <tbody>
                      {summary.byType.map((t) => (
                        <tr key={t.type} className="border-t">
                          <td className="px-3 py-1.5">{t.type}</td>
                          <td className="px-3 py-1.5 text-right tabular">{t.count}</td>
                          <td className="px-3 py-1.5 text-right tabular">{formatINR(t.amountPaise)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {(summary.cancelled + summary.nonAccounting + summary.unbalanced) > 0 && (
                <p className="text-xs text-muted-foreground">
                  Left out, as they post nothing to the books:
                  {summary.cancelled ? ` ${summary.cancelled} cancelled or optional;` : ''}
                  {summary.nonAccounting ? ` ${summary.nonAccounting} orders, notes, stock or memo vouchers;` : ''}
                  {summary.unbalanced ? ` ${summary.unbalanced} whose entries do not balance;` : ''}
                  {' '}the rest come across as journal entries with their Tally type, number and narration.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Ledgers become customers, vendors, bank and cash accounts and accounts; their balances become opening balances on the day the books start
                (Accountant → Opening Balances). Vouchers dated before that day are already in those openings. Vouchers are not invoices, so they do not
                enter the GST returns: bring across periods whose returns Tally already filed.
              </p>
              {tooBig && <p className="text-sm text-destructive">These files come to {(bytes / 1048576).toFixed(1)} MB; up to 24 MB go in one import. Export the Day Book a quarter at a time.</p>}
              {canImport ? (
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="outline" onClick={() => void run(true)} disabled={!!busy || tooBig} className="gap-1.5" data-slot="tally-check">
                    {busy === 'check' && <Loader2 className="size-4 animate-spin" />} Check
                  </Button>
                  <Button onClick={() => void run(false)} disabled={!!busy || !checked || tooBig} className="gap-1.5" data-slot="tally-bring-in">
                    {busy === 'import' && <Loader2 className="size-4 animate-spin" />} Bring it in
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Bringing a company across from Tally needs an accountant or an admin.</p>
              )}
            </>
          )}
        </Card>
      )}

      {result && <Outcomes result={result} />}

      <p className="text-xs text-muted-foreground">
        Tally on a PC in the office? <Link href="/tally" className="font-medium text-primary hover:underline">Connect it</Link> instead, and its companies stay in step on their own.
        Sending these books the other way? <Link href="/tally/export" className="font-medium text-primary hover:underline">Export to Tally</Link>.
      </p>
    </div>
  );
}

/** Where each kind of other file is read, for the list. */
const WHERE: Record<Other['home'], string> = {
  sheet: 'Import → Excel, CSV, text or JSON',
  pdf: 'Import → Invoices from PDF',
  quickbooks: 'Import → From QuickBooks',
  unreadable: '',
};

/** Files that are not Tally's: what each is, where it is read, and the way there. */
function OtherFiles({ files, onOpen, onClear }: { files: Other[]; onOpen: (open: 'sheet' | 'pdf') => void; onClear: () => void }) {
  const sheets = files.filter((f) => f.home === 'sheet').length;
  const pdfs = files.filter((f) => f.home === 'pdf').length;
  const quickbooks = files.some((f) => f.home === 'quickbooks');
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return (
    <Card className="space-y-3 border-t-4 border-t-sky-500 p-5" data-slot="tally-other-files">
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sky-600 text-white">
          <FileSpreadsheet className="size-4" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-semibold">{files.length === 1 ? 'This is not a Tally file' : 'These are not Tally files'}</p>
          <p className="text-xs text-muted-foreground">
            This screen reads the XML that Tally exports. {files.length === 1 ? 'This file is' : 'These files are'} read by Import instead,
            just as {files.length === 1 ? 'it is' : 'they are'}: nothing was uploaded yet.
          </p>
        </div>
        <Button variant="ghost" size="xs" onClick={onClear} data-slot="tally-other-files-clear">Clear</Button>
      </div>
      <ul className="space-y-1">
        {files.map((f) => (
          <li key={f.file.name} data-slot="tally-other-file" data-home={f.home} data-kind={f.kind ?? undefined}
            className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border bg-muted/40 px-2.5 py-1.5 text-xs">
            {f.home === 'pdf' ? <FileText className="size-3.5 shrink-0 text-rose-600" /> : <FileSpreadsheet className="size-3.5 shrink-0 text-emerald-600" />}
            <span className="min-w-0 flex-1 truncate font-medium">{f.file.name}</span>
            <span className="text-muted-foreground">
              {f.home === 'sheet' && (f.kind ? <>{TEMPLATES[f.kind].title} · {WHERE.sheet}</> : <>a spreadsheet · {WHERE.sheet}, where you pick what it holds</>)}
              {f.home === 'pdf' && <>an invoice or bill to read · {WHERE.pdf}</>}
              {f.home === 'quickbooks' && <>a QuickBooks file · {WHERE.quickbooks}</>}
              {f.home === 'unreadable' && (/\.xls$/i.test(f.file.name)
                ? <>an old Excel file: save it as .xlsx (File → Save As) and choose it again</>
                : <>not a file Rekonza reads: Excel (.xlsx), CSV, text, JSON, PDF or Tally&apos;s XML</>)}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap justify-end gap-2">
        {quickbooks && (
          <Button size="sm" variant="outline" asChild>
            <Link href="/settings/import?tab=quickbooks">Open From QuickBooks</Link>
          </Button>
        )}
        {pdfs > 0 && (
          <Button size="sm" variant={sheets ? 'outline' : 'default'} className="gap-1.5" onClick={() => onOpen('pdf')} data-slot="tally-other-pdfs">
            Read the {plural(pdfs, 'invoice', 'invoices')} <ArrowRight className="size-3.5" />
          </Button>
        )}
        {sheets > 0 && (
          <Button size="sm" className="gap-1.5" onClick={() => onOpen('sheet')} data-slot="tally-other-sheets">
            Import the {plural(sheets, 'spreadsheet', 'spreadsheets')} <ArrowRight className="size-3.5" />
          </Button>
        )}
      </div>
      {sheets > 0 && pdfs > 0 && (
        <p className="text-right text-[11px] text-muted-foreground">Either way, both go across: the spreadsheets on one tab, the invoices on the next.</p>
      )}
    </Card>
  );
}

/** Tally's data folder was chosen: what it is, and the two ways to bring that company here. */
function DataFilesHelp({ names, onClear }: { names: string[]; onClear: () => void }) {
  const shown = names.slice(0, 6).join(', ') + (names.length > 6 ? ` and ${names.length - 6} more` : '');
  return (
    <Card className="space-y-3 border-t-4 border-t-violet-500 p-5" data-slot="tally-data-files">
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-violet-600 text-white">
          <Database className="size-4" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-semibold">These are Tally&apos;s own data files</p>
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{shown}</span>: the folder TallyPrime keeps a company in. It is Tally&apos;s private
            database, not an export, and only TallyPrime can open it, so nothing was uploaded. Bring the company across through Tally in three steps:
          </p>
        </div>
        <Button variant="ghost" size="xs" onClick={onClear} data-slot="tally-data-files-clear">Clear</Button>
      </div>
      <ol className="list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-muted-foreground">
        <li>
          <span className="font-medium text-foreground">Put the folder where TallyPrime looks.</span> Copy the whole folder these files are in (it is named
          with a number, such as <em>100000</em>) into TallyPrime&apos;s data folder: the one under <kbd className="rounded border bg-muted px-1">F1</kbd> Help →
          Settings → Data Configuration, usually <span className="break-all font-mono text-[11px] text-foreground">{'C:\\Users\\Public\\TallyPrime\\data'}</span>. A Tally backup (<em>TBK900.001</em>) is restored
          instead, with <kbd className="rounded border bg-muted px-1">Alt+Y</kbd> Data → Restore.
        </li>
        <li>
          <span className="font-medium text-foreground">Open it in TallyPrime</span> with <kbd className="rounded border bg-muted px-1">F3</kbd> (Select
          Company). Data from Tally.ERP 9 is migrated by TallyPrime the first time it opens.
        </li>
        <li>
          <span className="font-medium text-foreground">Bring it here</span>, either way:
          <ul className="mt-1 list-disc space-y-1 pl-4">
            <li><Link href="/tally" className="font-medium text-primary hover:underline">Connect that PC</Link> with the REKONZA connector. It reads the open company through Tally, and keeps it in step every few minutes.</li>
            <li>Or export the masters and the Day Book as XML (step 1 above) and choose those files here.</li>
          </ul>
        </li>
      </ol>
    </Card>
  );
}

function Figure({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.11em] text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular">{value.toLocaleString('en-IN')}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}
