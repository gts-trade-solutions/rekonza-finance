'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Bringing data in: from a spreadsheet, or a company from Tally.
//
// Every import is checked first. The check does the whole import and throws it
// away, so what it reports is exactly what the real run will do; the real run
// keeps everything or nothing.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import Papa from 'papaparse';
import { AlertTriangle, ArrowLeft, CheckCircle2, Download, FileSpreadsheet, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/shared/page-header';
import { downloadCsv } from '@/components/shared/report-shell';
import { api, imports, type ImportOutcome, type ImportResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { columnFor, IMPORT_KINDS, MAX_IMPORT_ROWS, TEMPLATES, templateCsv, templateSheets, type ImportKind } from '@/lib/imports/templates';
import { downloadWorkbook } from '@/lib/xlsx';

const PART_LABEL: Record<string, string> = {
  contacts: 'Customers and vendors', items: 'Items', accounts: 'Accounts', 'opening-ledger': 'Ledger openings',
  'opening-bills': 'Unpaid bills', journals: 'Journal vouchers', invoices: 'Invoices', bills: 'Bills',
};

/** A cell as text the server reads: dates as yyyy-mm-dd. */
const cellText = (v: unknown) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : v === null || v === undefined ? '' : String(v);

export default function ImportPage() {
  return (
    <>
      <PageHeader
        title="Import"
        description="Bring masters, opening balances and vouchers in from a spreadsheet, or a whole company from Tally."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/settings"><ArrowLeft className="mr-1.5 size-3.5" /> Settings</Link>
          </Button>
        }
      />
      <Tabs defaultValue="sheet">
        <TabsList>
          <TabsTrigger value="sheet">From a spreadsheet</TabsTrigger>
          <TabsTrigger value="tally">From Tally</TabsTrigger>
        </TabsList>
        <TabsContent value="sheet" className="mt-4"><SheetImport /></TabsContent>
        <TabsContent value="tally" className="mt-4"><TallyImport /></TabsContent>
      </Tabs>
    </>
  );
}

function Outcomes({ result }: { result: ImportResponse }) {
  const failed = result.outcomes.reduce((t, o) => t + o.errors.length, 0);
  return (
    <Card className={`space-y-3 p-5 ${failed ? 'border-destructive/40' : 'border-emerald-500/40'}`}>
      <p className="flex items-center gap-2 text-sm font-medium">
        {failed ? <AlertTriangle className="size-4 text-destructive" /> : <CheckCircle2 className="size-4 text-emerald-600" />}
        {result.committed
          ? 'Imported.'
          : failed ? `${failed} problem(s) to fix. Nothing was imported.` : 'The check passed. Nothing has been imported yet.'}
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        {result.outcomes.filter((o) => o.rows > 0).map((o, i) => (
          <div key={`${o.kind}-${i}`} className="rounded-md border p-3 text-sm">
            <p className="font-medium">{PART_LABEL[o.kind] ?? o.kind}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {o.created} {result.committed ? 'added' : 'to add'}{o.skipped ? `, ${o.skipped} already there` : ''}
            </p>
          </div>
        ))}
      </div>
      <ErrorList outcomes={result.outcomes} />
      {result.outcomes.some((o) => o.notes.length > 0) && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {result.outcomes.flatMap((o) => o.notes).map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
    </Card>
  );
}

function ErrorList({ outcomes }: { outcomes: ImportOutcome[] }) {
  const errors = outcomes.flatMap((o) => o.errors.map((e) => ({ ...e, kind: o.kind })));
  if (!errors.length) return null;
  return (
    <div className="max-h-72 overflow-y-auto rounded-md border thin-scroll">
      <table className="w-full text-sm">
        <tbody>
          {errors.slice(0, 500).map((e, i) => (
            <tr key={i} className="border-b last:border-0">
              <td className="w-20 px-3 py-1.5 text-xs text-muted-foreground">{e.row ? `Row ${e.row}` : PART_LABEL[e.kind] ?? e.kind}</td>
              <td className="px-3 py-1.5 text-xs">{e.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SheetImport() {
  const [kind, setKind] = useState<ImportKind>('contacts');
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [headings, setHeadings] = useState<{ heading: string; key: string | null }[]>([]);
  const [fileName, setFileName] = useState('');
  const [onDuplicate, setOnDuplicate] = useState<'skip' | 'error'>('skip');
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [busy, setBusy] = useState<false | 'check' | 'import'>(false);
  const input = useRef<HTMLInputElement>(null);
  const t = TEMPLATES[kind];

  const missing = useMemo(
    () => t.columns.filter((c) => c.required && !headings.some((h) => h.key === c.key)).map((c) => c.label),
    [t, headings],
  );

  const reset = (k: ImportKind) => { setKind(k); setRows([]); setHeadings([]); setFileName(''); setResult(null); };

  const load = async (file: File | undefined) => {
    if (!file) return;
    setResult(null);
    try {
      let grid: unknown[][];
      if (/\.xlsx$/i.test(file.name)) {
        const { default: readXlsxFile } = await import('read-excel-file/browser');
        const sheets = (await readXlsxFile(file)) as unknown as { sheet: string; data: unknown[][] }[];
        grid = sheets.find((s) => s.data.some((r) => r.some((c) => c !== null && c !== '')))?.data ?? [];
      } else {
        const text = (await file.text()).replace(/^﻿/, '');
        grid = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' }).data;
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
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {t.columns.map((c) => (
              <Badge key={c.key} variant={c.required ? 'default' : 'outline'} className="text-[10px]" title={c.hint}>{c.label}</Badge>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <input ref={input} type="file" accept=".csv,.xlsx" className="hidden" onChange={(e) => void load(e.target.files?.[0])} />
            <Button size="sm" className="gap-1.5" onClick={() => input.current?.click()}>
              <Upload className="size-3.5" /> Choose a CSV or Excel file
            </Button>
            {fileName && <span className="text-xs text-muted-foreground"><FileSpreadsheet className="mr-1 inline size-3.5" />{fileName}: {rows.length} row(s)</span>}
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

/** Tally writes its XML in UTF-16; a saved copy may be UTF-8. */
async function readTallyFile(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const utf16 = (buf[0] === 0xff && buf[1] === 0xfe) || (buf.length > 1 && buf[1] === 0);
  return new TextDecoder(utf16 ? 'utf-16le' : 'utf-8').decode(buf).replace(/^﻿/, '');
}

function TallyImport() {
  const companies = useApi(
    () => api.get<{ companies: { id: string; name: string; asOf: string | null; ledgers: number; stockItems: number }[] }>('/api/tally')
      .catch(() => ({ companies: [] })),
    [],
  );
  const [source, setSource] = useState<{ kind: 'xml'; xml: string; name: string } | { kind: 'company'; id: string; name: string } | null>(null);
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [busy, setBusy] = useState<false | 'check' | 'import'>(false);
  const input = useRef<HTMLInputElement>(null);

  const run = async (dryRun: boolean) => {
    if (!source) return;
    setBusy(dryRun ? 'check' : 'import');
    try {
      const r = source.kind === 'xml' ? await imports.tallyXml(source.xml, dryRun) : await imports.tallyCompany(source.id, dryRun);
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
      <Card className="space-y-3 p-5 text-sm">
        <p className="font-medium">What comes across</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Sundry debtors and creditors become customers and vendors, with their unpaid bills (bill by bill when Tally kept
          them so). Bank and cash ledgers become bank and cash accounts. GST and TDS ledgers map to this book&apos;s own.
          Every other ledger becomes an account, and stock items become items with their quantity and value. Balances
          land as opening balances on the day the books start, set under Accountant → Opening balances; set that date first.
        </p>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="space-y-3 p-5">
          <p className="text-sm font-medium">A Tally XML file</p>
          <p className="text-xs text-muted-foreground">In TallyPrime: Export → Masters, format XML (data interchange). Opening balances are as at Tally&apos;s books beginning date.</p>
          <input ref={input} type="file" accept=".xml" className="hidden" onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setResult(null);
            setSource({ kind: 'xml', xml: await readTallyFile(f), name: f.name });
            if (input.current) input.current.value = '';
          }} />
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => input.current?.click()}>
            <Upload className="size-3.5" /> Choose the XML file
          </Button>
          {source?.kind === 'xml' && <p className="text-xs">{source.name}</p>}
        </Card>
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
