'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Invoices from PDF: choose PDFs or photos of tax invoices, have each read,
// check the list, bring it in.
//
// Each file is read on the server (POST /api/imports/pdf): whose invoice it is,
// the other company, number, date and year, lines and totals. The list is the
// place to put anything right — the direction, the company, the number, the
// date — before Check runs the whole import and throws it away, and Bring it
// in keeps it. Nothing is saved before that. Sample PDFs can be made here, to
// see the whole way through without a real invoice.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { FileText, Loader2, ScanText, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Outcomes } from '@/components/shared/import-outcomes';
import { formatINR } from '@/lib/money';
import { imports, type ImportResponse } from '@/lib/api/client';
import { usePermission } from '@/lib/store/hooks';
import { useAppStore } from '@/lib/store';
import {
  financialYear, lineTax, lineTaxable, sampleInvoicePdf,
  type Direction, type InvoiceReading, type PdfImportDoc,
} from '@/lib/imports/pdf-invoices';

const ACCEPT = 'application/pdf,.pdf,image/png,image/jpeg,image/webp';
const MAX_BYTES = 8 * 1024 * 1024;
/** Read two at a time: quick, without a queue of slow requests at the AI provider. */
const AT_ONCE = 2;

interface Row {
  key: string;
  reading: InvoiceReading;
  /** For opening the file beside its row, to compare. */
  url: string;
  direction: Direction;
  partyName: string;
  partyGstin: string;
  partyState: string;
  number: string;
  date: string;
}

const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

function rowOf(reading: InvoiceReading, url: string): Row {
  return {
    key: `${reading.file}-${Math.random().toString(36).slice(2, 8)}`,
    reading, url, direction: reading.direction,
    partyName: reading.matched?.name ?? reading.party.name ?? '',
    partyGstin: reading.party.gstin ?? '',
    partyState: reading.party.state ?? '',
    number: reading.number ?? '',
    date: reading.date ?? '',
  };
}

/** Switched between sale and purchase: the other company is the other side of the invoice. */
function turned(r: Row, direction: Direction): Row {
  const other = direction === 'sale' ? r.reading.buyer : r.reading.seller;
  return { ...r, direction, partyName: other.name ?? '', partyGstin: other.gstin ?? '', partyState: other.state ?? '' };
}

const missingOf = (r: Row) => [!r.partyName.trim() && 'company', !r.number.trim() && 'number', !/^\d{4}-\d{2}-\d{2}$/.test(r.date) && 'date', !r.reading.lines.length && 'lines'].filter(Boolean) as string[];

export function PdfInvoiceImport({ incoming }: { incoming?: File[] | null }) {
  const canSales = usePermission('sales', 'create');
  const canPurchases = usePermission('purchases', 'create');
  const org = useAppStore((s) => s.org);
  const branch = useAppStore((s) => s.branches.find((b) => b.id === s.activeBranchId) ?? s.branches[0]);
  const [rows, setRows] = useState<Row[]>([]);
  const [failed, setFailed] = useState<{ file: string; message: string }[]>([]);
  const [progress, setProgress] = useState<{ done: number; of: number } | null>(null);
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [busy, setBusy] = useState<false | 'check' | 'import'>(false);
  const input = useRef<HTMLInputElement>(null);

  const add = async (files: File[]) => {
    if (!files.length) return;
    setResult(null);
    const tooBig = files.filter((f) => f.size > MAX_BYTES);
    if (tooBig.length) setFailed((h) => [...h, ...tooBig.map((f) => ({ file: f.name, message: 'Larger than 8 MB: save it smaller, or a page at a time.' }))]);
    const queue = files.filter((f) => f.size <= MAX_BYTES);
    if (!queue.length) return;
    let done = 0;
    const total = queue.length;
    setProgress({ done: 0, of: queue.length });
    const work = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        const file = f;
        try {
          const reading = await imports.readPdfInvoice(file);
          setRows((have) => [...have, rowOf(reading, URL.createObjectURL(file))]);
        } catch (e) {
          setFailed((have) => [...have, { file: file.name, message: e instanceof Error ? e.message : String(e) }]);
        } finally {
          done += 1;
          setProgress({ done, of: total });
        }
      }
    };
    await Promise.all(Array.from({ length: AT_ONCE }, work));
    setProgress(null);
  };

  // Files handed over from the spreadsheet tab, when PDFs were chosen there.
  useEffect(() => {
    if (incoming?.length) void add(incoming);
  }, [incoming]);

  const trySample = (kind: Direction) => {
    const { bytes, filename } = sampleInvoicePdf(kind, { name: org?.name || '', gstin: branch?.gstin || null }, today());
    void add([new File([bytes as BlobPart], filename, { type: 'application/pdf' })]);
  };

  const edit = (key: string, change: (r: Row) => Row) => {
    setRows((have) => have.map((r) => (r.key === key ? change(r) : r)));
    setResult(null);
  };
  const remove = (key: string) => {
    setRows((have) => have.filter((r) => r.key !== key));
    setResult(null);
  };

  const docs: PdfImportDoc[] = rows.map((r) => ({
    file: r.reading.file, direction: r.direction,
    partyName: r.partyName.trim(), partyGstin: r.partyGstin.trim() || null, partyState: r.partyState.trim() || null,
    number: r.number.trim(), date: r.date, dueDate: r.reading.dueDate && r.reading.dueDate >= r.date ? r.reading.dueDate : null,
    lines: r.reading.lines,
  }));
  const incomplete = rows.filter((r) => missingOf(r).length > 0).length;
  const sales = rows.filter((r) => r.direction === 'sale').length;
  const credits = rows.reduce((t, r) => t + r.reading.chargedMc, 0) / 1000;
  const blocked = !canSales || (rows.some((r) => r.direction === 'purchase') && !canPurchases);

  const run = async (dryRun: boolean) => {
    setBusy(dryRun ? 'check' : 'import');
    try {
      const r = await imports.pdfInvoices(docs, dryRun);
      setResult(r);
      if (r.committed) {
        const parts = r.outcomes.filter((o) => o.kind === 'invoices' || o.kind === 'bills');
        const added = parts.reduce((t, o) => t + o.created, 0);
        const left = parts.reduce((t, o) => t + o.skipped, 0);
        toast.success(`${added} invoice${added === 1 ? '' : 's'} brought in`, left ? { description: `${left} already in the books, so left out.` } : undefined);
      }
    } catch (e) {
      toast.error('The import did not run', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const checked = !!result && !result.committed && result.outcomes.every((o) => o.errors.length === 0);

  return (
    <div className="space-y-4" data-slot="pdf-invoice-import">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-3 border-t-4 border-t-violet-500 p-5">
          <p className="text-sm font-semibold">1 · Choose the invoices</p>
          <p className="text-xs text-muted-foreground">
            PDFs or photos of tax invoices: your own sales invoices (from an old system, say) and the bills other companies sent you, mixed
            as they come. Each is read by the AI assistant, which uses credits. Nothing is saved until you bring them in.
          </p>
          <input ref={input} type="file" accept={ACCEPT} multiple className="hidden" data-slot="pdf-file-input"
            onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ''; void add(files); }} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" className="gap-1.5" onClick={() => input.current?.click()} disabled={!!progress} data-slot="pdf-choose">
              {progress ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} Choose PDF invoices
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => trySample('purchase')} disabled={!!progress} data-slot="pdf-sample-bill">
              <FileText className="size-3.5" /> Sample: a supplier&apos;s bill
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => trySample('sale')} disabled={!!progress} data-slot="pdf-sample-invoice">
              <FileText className="size-3.5" /> Sample: our invoice
            </Button>
          </div>
          {progress && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-slot="pdf-progress">
              <ScanText className="size-3.5" /> Reading {Math.min(progress.done + 1, progress.of)} of {progress.of}…
            </p>
          )}
        </Card>

        <Card className="space-y-2 border-t-4 border-t-blue-500 p-5">
          <p className="text-sm font-semibold">How each invoice is placed</p>
          <ul className="list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-muted-foreground">
            <li><span className="font-medium text-foreground">Your GSTIN as the seller:</span> your own invoice, brought in as a sales invoice under its own number.</li>
            <li><span className="font-medium text-foreground">Your GSTIN as the buyer:</span> another company&apos;s invoice to you, brought in as a bill.</li>
            <li><span className="font-medium text-foreground">The other company:</span> found among your customers and suppliers by GSTIN or name, or added as a new one.</li>
            <li><span className="font-medium text-foreground">The year:</span> from the invoice date, April to March. Each invoice goes into its own year.</li>
          </ul>
          <p className="text-xs text-muted-foreground">Anything read wrongly can be put right in the list before it goes in.</p>
        </Card>
      </div>

      {failed.length > 0 && (
        <Card className="space-y-1.5 border-destructive/40 p-4" data-slot="pdf-failed">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-destructive">Not read</p>
            <Button variant="ghost" size="xs" onClick={() => setFailed([])}>Clear</Button>
          </div>
          <ul className="space-y-1 text-xs">
            {failed.map((f, i) => <li key={`${f.file}-${i}`}><span className="font-medium">{f.file}</span>: {f.message}</li>)}
          </ul>
        </Card>
      )}

      {rows.length > 0 && (
        <Card className="space-y-4 border-t-4 border-t-emerald-500 p-5" data-slot="pdf-review">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-semibold">2 · Check what was read</p>
            <p className="text-xs text-muted-foreground" data-slot="pdf-counts">
              {sales} sales invoice{sales === 1 ? '' : 's'}, {rows.length - sales} supplier bill{rows.length - sales === 1 ? '' : 's'}
              {credits > 0 ? ` · read for ${credits.toLocaleString('en-IN', { maximumFractionDigits: 2 })} credits` : ''}
            </p>
          </div>
          <div className="space-y-3">
            {rows.map((r) => <ReviewRow key={r.key} row={r} onEdit={(change) => edit(r.key, change)} onRemove={() => remove(r.key)} />)}
          </div>
          {incomplete > 0 && <p className="text-sm text-destructive">{incomplete} invoice{incomplete === 1 ? ' needs' : 's need'} the company, number, date or lines filled in before it can go in.</p>}
          {blocked ? (
            <p className="text-xs text-muted-foreground">Bringing in sales invoices needs the sales role, and supplier bills the purchases role. Ask an accountant or an admin.</p>
          ) : (
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => void run(true)} disabled={!!busy || !!progress || incomplete > 0} className="gap-1.5" data-slot="pdf-check">
                {busy === 'check' && <Loader2 className="size-4 animate-spin" />} Check
              </Button>
              <Button onClick={() => void run(false)} disabled={!!busy || !!progress || !checked} className="gap-1.5" data-slot="pdf-bring-in">
                {busy === 'import' && <Loader2 className="size-4 animate-spin" />} Bring it in
              </Button>
            </div>
          )}
        </Card>
      )}

      {result && <Outcomes result={result} />}
    </div>
  );
}

function ReviewRow({ row: r, onEdit, onRemove }: { row: Row; onEdit: (change: (r: Row) => Row) => void; onRemove: () => void }) {
  const taxable = r.reading.lines.reduce((t, l) => t + lineTaxable(l), 0);
  const tax = r.reading.lines.reduce((t, l) => t + lineTax(l), 0);
  const fy = financialYear(r.date);
  const missing = missingOf(r);
  const matched = r.reading.matched && r.reading.matched.name === r.partyName;
  return (
    <div className="rounded-md border" data-slot="pdf-row" data-direction={r.direction}>
      <div className="grid gap-3 p-3 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
        <div className="min-w-0 space-y-1.5">
          <a href={r.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 truncate text-xs font-medium text-primary hover:underline" title="Open the file">
            <FileText className="size-3.5 shrink-0" /> <span className="truncate">{r.reading.file}</span>
          </a>
          <select className="h-8 w-full rounded-md border bg-background px-2 text-xs" value={r.direction} aria-label="Sale or purchase" data-slot="pdf-direction"
            onChange={(e) => onEdit((x) => turned(x, e.target.value as Direction))}>
            <option value="sale">Our sales invoice</option>
            <option value="purchase">A supplier&apos;s bill to us</option>
          </select>
          {r.reading.sample && <p className="text-[11px] text-muted-foreground">Sample PDF: read from its own contents, at no charge.</p>}
        </div>
        <div className="min-w-0 space-y-1.5">
          <label className="block text-[11px] text-muted-foreground">{r.direction === 'sale' ? 'Customer' : 'Supplier'}{matched ? ' · already in your books' : r.partyName ? ' · new' : ''}</label>
          <Input className="h-8 text-xs" value={r.partyName} aria-label="Other company" data-slot="pdf-party"
            onChange={(e) => onEdit((x) => ({ ...x, partyName: e.target.value }))} />
          <div className="grid grid-cols-2 gap-1.5">
            <Input className="h-8 font-mono text-[11px]" value={r.partyGstin} placeholder="GSTIN" aria-label="GSTIN"
              onChange={(e) => onEdit((x) => ({ ...x, partyGstin: e.target.value.toUpperCase() }))} />
            <Input className="h-8 text-xs" value={r.partyState} placeholder="State (no GSTIN)" aria-label="State" disabled={!!r.partyGstin}
              onChange={(e) => onEdit((x) => ({ ...x, partyState: e.target.value }))} />
          </div>
        </div>
        <div className="min-w-0 space-y-1.5">
          <label className="block text-[11px] text-muted-foreground">Invoice number</label>
          <Input className="h-8 text-xs" value={r.number} aria-label="Invoice number" data-slot="pdf-number"
            onChange={(e) => onEdit((x) => ({ ...x, number: e.target.value }))} />
        </div>
        <div className="min-w-0 space-y-1.5">
          <label className="block text-[11px] text-muted-foreground">Date{fy ? <span className="font-medium text-foreground" data-slot="pdf-fy"> · {fy}</span> : ''}</label>
          <Input type="date" className="h-8 text-xs" value={r.date} aria-label="Invoice date" data-slot="pdf-date"
            onChange={(e) => onEdit((x) => ({ ...x, date: e.target.value }))} />
        </div>
        <div className="flex items-start justify-between gap-2 md:flex-col md:items-end">
          <p className="text-right text-sm font-semibold tabular" data-slot="pdf-total">{formatINR(taxable + tax)}</p>
          <button type="button" aria-label={`Leave out ${r.reading.file}`} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={onRemove}>
            <X className="size-4" />
          </button>
        </div>
      </div>
      {(missing.length > 0 || r.reading.notes.length > 0) && (
        <ul className="list-disc space-y-0.5 border-t bg-amber-50/60 px-3 py-2 pl-7 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200" data-slot="pdf-notes">
          {missing.length > 0 && <li>Fill in the {missing.join(', ')}.</li>}
          {r.reading.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
      <details className="border-t px-3 py-2 text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          {r.reading.lines.length} line{r.reading.lines.length === 1 ? '' : 's'} · {formatINR(taxable)} before tax, {formatINR(tax)} GST
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[460px] text-xs">
            <thead className="bg-table-head text-table-head-foreground">
              <tr>
                <th className="px-2 py-1 text-left font-semibold">Description</th>
                <th className="px-2 py-1 text-left font-semibold">HSN/SAC</th>
                <th className="px-2 py-1 text-right font-semibold">Qty</th>
                <th className="px-2 py-1 text-right font-semibold">Rate</th>
                <th className="px-2 py-1 text-right font-semibold">GST</th>
                <th className="px-2 py-1 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody>
              {r.reading.lines.map((l, i) => (
                <tr key={i} className="border-t">
                  <td className="px-2 py-1">{l.description}</td>
                  <td className="px-2 py-1">{l.hsnSac ?? ''}</td>
                  <td className="px-2 py-1 text-right tabular">{l.qty}</td>
                  <td className="px-2 py-1 text-right tabular">{formatINR(l.ratePaise)}</td>
                  <td className="px-2 py-1 text-right tabular">{l.gstRatePct}%</td>
                  <td className="px-2 py-1 text-right tabular">{formatINR(lineTaxable(l))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
