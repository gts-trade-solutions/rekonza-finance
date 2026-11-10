'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Import from QuickBooks: Desktop's IIF files, and Online's lists and Journal
// report as Excel, CSV or text. Read here first and shown — accounts,
// customers, vendors, items, transactions — then checked on the server (the
// whole import, thrown away), then brought in. The same files twice add
// nothing the second time.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import { Download, FileSpreadsheet, Loader2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Outcomes } from '@/components/shared/import-outcomes';
import { formatINR } from '@/lib/money';
import { dayLabel } from '@/lib/date-range';
import { imports, type ImportResponse } from '@/lib/api/client';
import { usePermission } from '@/lib/store/hooks';
import { guessDelimiter, readTextFile } from '@/lib/delimited';
import { iifRows, parseQuickBooks, summariseQuickBooks, type QbDateOrder, type QbFile } from '@/lib/quickbooks/parse';
import { quickBooksSampleIif } from '@/lib/quickbooks/sample';

const MAX_UPLOAD = 24 * 1024 * 1024;
const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const cellText = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v === null || v === undefined ? '' : String(v));

/** Any file QuickBooks writes, as rows of text: IIF and text by tab, CSV by its separator, Excel by its sheet. */
async function readQbFile(file: File): Promise<QbFile> {
  if (/\.xlsx$/i.test(file.name)) {
    const { default: readXlsxFile } = await import('read-excel-file/browser');
    const sheets = (await readXlsxFile(file)) as unknown as { sheet: string; data: unknown[][] }[];
    const data = sheets.find((s) => s.data.some((r) => r.some((c) => c !== null && c !== '')))?.data ?? [];
    return { name: file.name, rows: data.map((r) => r.map(cellText)) };
  }
  const text = await readTextFile(file);
  if (/\.iif$/i.test(file.name) || /^\s*!/.test(text)) return { name: file.name, rows: iifRows(text) };
  const rows = Papa.parse<string[]>(text, { delimiter: guessDelimiter(text), skipEmptyLines: 'greedy' }).data;
  return { name: file.name, rows };
}

function downloadSample() {
  const blob = new Blob([quickBooksSampleIif(today())], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `quickbooks-sample-${today()}.iif`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function QuickBooksImport() {
  const canBooks = usePermission('accountant', 'create');
  const canSales = usePermission('sales', 'create');
  const canImport = canBooks && canSales;
  const [files, setFiles] = useState<(QbFile & { size: number })[]>([]);
  const [order, setOrder] = useState<QbDateOrder>('auto');
  const [reading, setReading] = useState(false);
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [busy, setBusy] = useState<false | 'check' | 'import'>(false);
  const input = useRef<HTMLInputElement>(null);

  const summary = useMemo(() => (files.length ? summariseQuickBooks(parseQuickBooks(files, order)) : null), [files, order]);
  const payload = useMemo(() => files.map((f) => ({ name: f.name, rows: f.rows })), [files]);
  const bytes = useMemo(() => new Blob([JSON.stringify(payload)]).size, [payload]);
  const tooBig = bytes > MAX_UPLOAD;
  const empty = !!summary && !summary.accounts && !summary.customers && !summary.vendors && !summary.items && !summary.transactions;

  const add = async (list: FileList | null) => {
    if (!list?.length) return;
    setReading(true);
    try {
      const read = await Promise.all([...list].map(async (f) => ({ ...(await readQbFile(f)), size: f.size })));
      setFiles((have) => [...have.filter((h) => !read.some((r) => r.name === h.name)), ...read]);
      setResult(null);
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
      const r = await imports.quickBooks(payload, order, dryRun);
      setResult(r);
      if (r.committed) toast.success('Brought in from QuickBooks');
    } catch (e) {
      toast.error('The import did not run', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const checked = !!result && !result.committed && result.outcomes.every((o) => o.errors.length === 0);

  return (
    <div className="space-y-4" data-slot="quickbooks-import">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-3 border-t-4 border-t-emerald-500 p-5">
          <p className="text-sm font-semibold">1 · Export from QuickBooks</p>
          <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
            <p><span className="font-medium text-foreground">QuickBooks Online:</span> ⚙ Settings → <em>Export data</em> → Lists (Account List, Customers, Vendors, Products and Services); and <em>Reports → Journal</em>, set the period, then Export to Excel or CSV for the transactions.</p>
            <p><span className="font-medium text-foreground">QuickBooks Desktop:</span> <em>File → Utilities → Export → Lists to IIF Files</em> (chart of accounts, customers, vendors, items). For transactions, <em>Reports → Accountant &amp; Taxes → Journal</em>, then Excel → CSV.</p>
          </div>
          <p className="text-xs text-muted-foreground">Bring the lists with the transactions, or the lists first. The same transaction never comes in twice.</p>
        </Card>
        <Card className="space-y-3 border-t-4 border-t-blue-500 p-5">
          <p className="text-sm font-semibold">2 · Choose the files</p>
          <p className="text-xs text-muted-foreground">.iif, .xlsx, .csv or .txt — one or several. They are read here first; nothing is saved until you bring them in.</p>
          <input ref={input} type="file" multiple accept=".iif,.xlsx,.csv,.txt,.tsv,text/csv,text/plain" className="hidden" data-slot="qb-file-input"
            onChange={(e) => void add(e.target.files)} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" className="gap-1.5" onClick={() => input.current?.click()} disabled={reading} data-slot="qb-choose-files">
              {reading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} Choose QuickBooks files
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={downloadSample} data-slot="qb-sample">
              <Download className="size-3.5" /> Sample QuickBooks file
            </Button>
          </div>
          {files.length > 0 && (
            <ul className="space-y-1">
              {files.map((f) => (
                <li key={f.name} className="flex items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5 text-xs">
                  <FileSpreadsheet className="size-3.5 shrink-0 text-emerald-600" />
                  <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
                  <span className="hidden text-muted-foreground sm:inline">{summary?.files.find((x) => x.name === f.name)?.read}</span>
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

      {summary && (
        <Card className="space-y-4 border-t-4 border-t-violet-500 p-5" data-slot="qb-summary">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold">3 · What the {files.length === 1 ? 'file holds' : `${files.length} files hold`}</p>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Dates are written
              <select className="h-8 rounded-md border bg-background px-2 text-xs" value={order} onChange={(e) => { setOrder(e.target.value as QbDateOrder); setResult(null); }} data-slot="qb-date-order">
                <option value="auto">{`as found (${summary.dateOrder === 'dmy' ? 'day first' : 'month first'}${summary.dateOrderAssumed ? ', assumed' : ''})`}</option>
                <option value="dmy">day first: 31/03/2026</option>
                <option value="mdy">month first: 03/31/2026</option>
              </select>
            </label>
          </div>
          {empty ? (
            <p className="text-sm text-destructive">Nothing QuickBooks wrote was found. Export an IIF file, or the Account List, Customers, Vendors, Products and Services or the Journal report.</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <Figure label="Accounts" value={summary.accounts} />
                <Figure label="Customers" value={summary.customers} />
                <Figure label="Vendors" value={summary.vendors} />
                <Figure label="Items" value={summary.items} />
                <Figure label="Transactions" value={summary.posting} sub={summary.from ? `${dayLabel(summary.from)} to ${dayLabel(summary.to!)}` : undefined} />
              </div>
              {summary.byType.length > 0 && (
                <div className="overflow-hidden rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="bg-table-head text-table-head-foreground">
                      <tr><th className="px-3 py-2 text-left text-xs font-semibold">Transaction type</th><th className="px-3 py-2 text-right text-xs font-semibold">Count</th><th className="px-3 py-2 text-right text-xs font-semibold">Amount</th></tr>
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
              {summary.warnings.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-xs text-amber-700 dark:text-amber-300">
                  {summary.warnings.map((w) => <li key={w}>{w}</li>)}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">
                Accounts come in under the group their QuickBooks type matches; customers and vendors with their details; items as goods
                or services with their prices. {summary.balancesUsed
                  ? 'With no transactions in the files, the balances on the lists become opening balances on the day the books start.'
                  : 'The transactions come across as journal entries; balances on the lists are left out, so nothing is counted twice.'}
                {' '}Transactions are not invoices here, so they do not enter the GST returns.
              </p>
              {tooBig && <p className="text-sm text-destructive">These files come to {(bytes / 1048576).toFixed(1)} MB; up to 24 MB go in one import. Export the Journal a quarter at a time.</p>}
              {canImport ? (
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="outline" onClick={() => void run(true)} disabled={!!busy || tooBig} className="gap-1.5" data-slot="qb-check">
                    {busy === 'check' && <Loader2 className="size-4 animate-spin" />} Check
                  </Button>
                  <Button onClick={() => void run(false)} disabled={!!busy || !checked || tooBig} className="gap-1.5" data-slot="qb-bring-in">
                    {busy === 'import' && <Loader2 className="size-4 animate-spin" />} Bring it in
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Bringing a company across from QuickBooks needs an accountant or an admin.</p>
              )}
            </>
          )}
        </Card>
      )}

      {result && <Outcomes result={result} />}
    </div>
  );
}

function Figure({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.11em] text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular">{value.toLocaleString('en-IN')}</p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}
