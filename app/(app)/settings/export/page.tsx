'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Export data: any part of the books as CSV, text (tab-separated, or any other
// separator), Excel or JSON; or the whole book as one JSON backup, or as a zip
// of CSV or text files (services/data-export.ts).
//
// Customers and vendors, items, accounts, journals, invoices and bills come
// out in the columns their import reads, so a JSON (or CSV) export goes
// straight back in on the Import page — into this book or another.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, DatabaseBackup, Download, FileArchive, FileJson, FileSpreadsheet, FileText, FileType, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage } from '@/components/shared/async-state';
import { downloadCsv, downloadDelimited, downloadJson } from '@/components/shared/report-shell';
import { DELIMITERS, toDelimited } from '@/lib/delimited';
import { api, ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { downloadWorkbook, downloadZip } from '@/lib/xlsx';
import { cn } from '@/lib/utils';

interface ModuleInfo { key: string; label: string; dated: boolean; importKind: string | null }
type Format = 'csv' | 'txt' | 'dsv' | 'xlsx' | 'json';
type Period = 'all' | 'this_fy' | 'last_fy' | 'custom';

const fyStart = () => {
  const d = new Date();
  return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
};
const rangeFor = (p: Period, from: string, to: string): { from?: string; to?: string } => {
  const y = fyStart();
  if (p === 'this_fy') return { from: `${y}-04-01`, to: `${y + 1}-03-31` };
  if (p === 'last_fy') return { from: `${y - 1}-04-01`, to: `${y}-03-31` };
  if (p === 'custom') return { from, to };
  return {};
};

type Row = Record<string, string | number | null>;
const grid = (rows: Row[]): (string | number)[][] => {
  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  return [cols, ...rows.map((r) => cols.map((c) => r[c] ?? ''))];
};

export default function ExportPage() {
  const state = useApi<{ modules: ModuleInfo[] }>(() => api.get('/api/export'), []);
  const canBackup = usePermission('settings', 'view');
  const [module, setModule] = useState('contacts');
  const [format, setFormat] = useState<Format>('csv');
  const [period, setPeriod] = useState<Period>('all');
  const [from, setFrom] = useState(`${fyStart()}-04-01`);
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState<false | 'module' | 'backup' | 'zip'>(false);
  // The separator for "Delimited text": a pipe unless another is chosen.
  const [sep, setSep] = useState('|');
  const [otherSep, setOtherSep] = useState('');
  const separator = sep === 'other' ? otherSep.slice(0, 1) : sep;

  const run = async (m: ModuleInfo) => {
    setBusy('module');
    try {
      const r = await api.get<{ rows: Row[]; label: string; from?: string; to?: string }>('/api/export', { module: m.key, ...(m.dated ? rangeFor(period, from, to) : {}) });
      const name = `rekonza-${m.key}${r.from && r.from !== '1900-01-01' ? `-${r.from}-to-${r.to}` : ''}`;
      if (!r.rows.length) {
        toast.info(`No ${m.label.toLowerCase()} to export${m.dated && period !== 'all' ? ' in that period' : ''}.`);
        return;
      }
      if (format === 'json') downloadJson(`${name}.json`, r);
      else if (format === 'xlsx') downloadWorkbook(name, [{ name: m.label.slice(0, 31), rows: grid(r.rows) }]);
      else if (format === 'txt') downloadDelimited(`${name}.txt`, grid(r.rows), '\t');
      else if (format === 'dsv') {
        if (!separator) { toast.error('Type the separator to use.'); return; }
        downloadDelimited(`${name}.txt`, grid(r.rows), separator);
      } else downloadCsv(`${name}.csv`, grid(r.rows));
      toast.success(`${r.rows.length} row(s) of ${m.label.toLowerCase()} exported`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'The export did not run');
    } finally {
      setBusy(false);
    }
  };

  const backup = async () => {
    setBusy('backup');
    try {
      const r = await api.get<{ modules: Record<string, unknown[]> }>('/api/export', { module: 'all' });
      downloadJson(`rekonza-backup-${new Date().toISOString().slice(0, 10)}.json`, r);
      const total = Object.values(r.modules).reduce((t, x) => t + x.length, 0);
      toast.success('Backup downloaded', { description: `${Object.keys(r.modules).length} modules, ${total} rows, in one JSON file.` });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'The backup did not run');
    } finally {
      setBusy(false);
    }
  };

  /** Every module, every date, one file each in a zip: CSV, or text with the chosen separator. */
  const zipAll = async (delimiter: string, ext: 'csv' | 'txt') => {
    setBusy('zip');
    try {
      const r = await api.get<{ modules: Record<string, Row[]> }>('/api/export', { module: 'all' });
      const files = Object.entries(r.modules).filter(([, rows]) => rows.length)
        .map(([key, rows]): [string, string] => [`${key}.${ext}`, `\uFEFF${toDelimited(grid(rows), delimiter)}`]);
      downloadZip(`rekonza-all-${ext === 'csv' ? 'csv' : 'text'}-${new Date().toISOString().slice(0, 10)}.zip`, files);
      toast.success('All data downloaded', { description: `${files.length} files in one zip.` });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'The export did not run');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Export data"
        description="Take any part of the books out as CSV, text (tab, pipe or any separator), Excel or JSON — or the whole book at once."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/settings"><ArrowLeft className="mr-1.5 size-3.5" /> Settings</Link>
          </Button>
        }
      />
      <AsyncPage state={state}>
        {(d) => {
          const current = d.modules.find((m) => m.key === module) ?? d.modules[0];
          return (
            <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
              <Card className="h-fit p-2">
                {d.modules.map((m) => (
                  <button key={m.key} type="button" onClick={() => setModule(m.key)}
                    className={cn('flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm', m.key === current?.key ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-accent')}>
                    <span className="min-w-0 flex-1">{m.label}</span>
                    {m.importKind && <Badge variant="outline" className="text-[9px]">re-importable</Badge>}
                  </button>
                ))}
              </Card>

              <div className="space-y-4">
                {current && (
                  <Card className="space-y-4 p-5">
                    <div>
                      <h3 className="text-sm font-semibold">{current.label}</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {current.importKind
                          ? 'Exported in the columns the Import page reads, so the file can go straight back in — here or in another company.'
                          : 'Every record with its key figures, one row each.'}
                      </p>
                    </div>

                    {current.dated && (
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-muted-foreground">Period</p>
                        <div className="flex flex-wrap gap-2">
                          {([['all', 'All dates'], ['this_fy', 'This financial year'], ['last_fy', 'Last financial year'], ['custom', 'Custom']] as const).map(([k, label]) => (
                            <Button key={k} size="sm" variant={period === k ? 'default' : 'outline'} onClick={() => setPeriod(k)}>{label}</Button>
                          ))}
                        </div>
                        {period === 'custom' && (
                          <div className="flex flex-wrap items-center gap-2">
                            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-40" aria-label="From" />
                            <span className="text-xs text-muted-foreground">to</span>
                            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-40" aria-label="To" />
                          </div>
                        )}
                      </div>
                    )}

                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">Format</p>
                      <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-5" data-slot="export-formats">
                        {([
                          ['csv', 'CSV', 'Comma-separated, opens in any spreadsheet', FileText],
                          ['txt', 'Text (.txt)', 'Tab-separated text', FileType],
                          ['dsv', 'Delimited text', 'Pipe, semicolon or a separator of your own', FileType],
                          ['xlsx', 'Excel (.xlsx)', 'Numbers stay numbers', FileSpreadsheet],
                          ['json', 'JSON', 'For other software, or to import back', FileJson],
                        ] as const).map(([k, label, hint, Icon]) => (
                          <button key={k} type="button" onClick={() => setFormat(k)} data-format={k}
                            className={cn('flex items-start gap-2 rounded-md border p-3 text-left', format === k ? 'border-primary bg-primary/5' : 'hover:bg-accent/50')}>
                            <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                            <span><span className="block text-sm font-medium">{label}</span><span className="text-xs text-muted-foreground">{hint}</span></span>
                          </button>
                        ))}
                      </div>
                      {format === 'dsv' && (
                        <div className="flex flex-wrap items-center gap-2" data-slot="export-separator">
                          <span className="text-xs text-muted-foreground">Separator</span>
                          {[...DELIMITERS.filter((d) => d.key !== 'comma'), { key: 'other', char: 'other', label: 'Other' }].map((d) => (
                            <Button key={d.key} size="sm" variant={sep === d.char ? 'default' : 'outline'} onClick={() => setSep(d.char)}>{d.label}</Button>
                          ))}
                          {sep === 'other' && (
                            <Input value={otherSep} onChange={(e) => setOtherSep(e.target.value.slice(0, 1))} placeholder="e.g. ~" className="h-8 w-16 text-center font-mono" aria-label="Separator" />
                          )}
                        </div>
                      )}
                    </div>

                    <div className="flex justify-end">
                      <Button onClick={() => void run(current)} disabled={!!busy} className="gap-1.5">
                        {busy === 'module' ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} Export
                      </Button>
                    </div>
                  </Card>
                )}

                {canBackup && (
                  <Card className="flex flex-wrap items-center gap-4 p-5">
                    <DatabaseBackup className="size-5 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-semibold">Back up all data</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Every module above, every date: in one JSON file, or as a zip with one CSV or tab-separated text file per
                        module — a copy of the books you keep yourself. Its re-importable modules can be loaded back on the Import page.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" onClick={() => void backup()} disabled={!!busy} className="gap-1.5">
                        {busy === 'backup' ? <Loader2 className="size-4 animate-spin" /> : <FileJson className="size-4" />} Backup (JSON)
                      </Button>
                      <Button variant="outline" onClick={() => void zipAll(',', 'csv')} disabled={!!busy} className="gap-1.5" data-slot="export-all-csv">
                        {busy === 'zip' ? <Loader2 className="size-4 animate-spin" /> : <FileArchive className="size-4" />} All as CSV (.zip)
                      </Button>
                      <Button variant="outline" onClick={() => void zipAll('\t', 'txt')} disabled={!!busy} className="gap-1.5" data-slot="export-all-text">
                        <FileArchive className="size-4" /> All as text (.zip)
                      </Button>
                    </div>
                  </Card>
                )}

                <p className="text-xs text-muted-foreground">
                  GST returns have their own files: GSTR-1 and IFF JSON on their pages, the GSTR-3B return file on the GSTR-3B page,
                  GSTR-2B and 2A JSON imported on ITC Reconciliation, and an invoice&apos;s e-invoice JSON on the invoice.
                  To bring data in, use <Link href="/settings/import" className="text-primary hover:underline">Import</Link>.
                </p>
              </div>
            </div>
          );
        }}
      </AsyncPage>
    </>
  );
}
