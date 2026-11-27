'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Export the audit trail: every event the screen's filters find, as CSV, XLS,
// XLSX or PDF, named after the company and the range so the file says what it
// is in a folder of audit papers.
//
// The XLSX carries the date and time as real Excel dates (Indian time), so the
// auditor can sort and filter by them; the PDF is A4 landscape with the
// company, every filter applied, the chain head (lib/server/audit-chain.ts),
// and "Page n of N" on every page. Nothing is capped at the screen's page or
// at the usual export dialog's 25,000 rows: the server reads the whole range
// in batches and the file holds all of it.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { passwordProblem } from '@/components/shared/export-dialog';
import { auditTrail } from '@/lib/api/client';
import { downloadExport, istWallClock, type Cell } from '@/lib/xlsx';
import { downloadPdf, istNow, pdfTable } from '@/lib/pdf';
import { allowOutput } from '@/lib/output-guard';

export interface AuditFilters { targetType: string; action: string; actorUserId?: string; from?: string; to?: string; search?: string }

type Format = 'xlsx' | 'csv' | 'xls' | 'pdf';
const FORMATS: [Format, string][] = [
  ['xlsx', 'XLSX (Microsoft Excel), dates as real dates'],
  ['csv', 'CSV (Comma Separated Value)'],
  ['xls', 'XLS (Microsoft Excel 1997-2004 Compatible)'],
  ['pdf', 'PDF (A4 landscape, paginated, for the audit file)'],
];

/** "Audit trail - Race Auto Spares Pvt Ltd - 2026-11-01 to 2026-11-27": no characters a file name cannot hold. */
export function auditFileName(company: string, from?: string, to?: string): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  return `Audit trail - ${company} - ${from || 'start'} to ${to || today}`.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function AuditExportDialog({ open, onOpenChange, filters, userName }: {
  open: boolean; onOpenChange: (o: boolean) => void; filters: AuditFilters; userName: string;
}) {
  const [format, setFormat] = useState<Format>('xlsx');
  const [withIp, setWithIp] = useState(true);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const go = async () => {
    const problem = format === 'pdf' ? null : passwordProblem(password);
    if (problem) { toast.error(problem); return; }
    setBusy(true);
    try {
      const r = await auditTrail.exportRows({ ...filters, pii: withIp, format });
      const name = auditFileName(r.company, filters.from, filters.to);
      if (format === 'pdf') {
        // downloadExport passes the gate itself; the PDF is written here, so it passes it here.
        if (!allowOutput('export', name)) return;
        const widths = [1.25, 1, 0.65, 0.9, 0.55, 1.3, 2.4, 1.2, ...(withIp ? [0.9] : []), 2, 1.8];
        const bytes = pdfTable({
          title: 'Audit trail (edit log)',
          org: r.company,
          lines: [
            ...r.filters,
            `${r.rows.length.toLocaleString('en-IN')} event${r.rows.length === 1 ? '' : 's'}, newest first. Times are Indian Standard Time.`,
            `Hash chain head at export: ${r.chain.headHash} (${r.chain.headSeq} links). Kept under the Companies (Accounts) Rules, 2014, rule 3(1); it cannot be disabled or edited.`,
          ],
          columns: r.header.map((h, i) => ({ header: h, width: widths[i] ?? 1, align: 'left' as const })),
          rows: r.rows,
          landscape: true,
          fontSize: 6.5,
          footer: `Exported ${istNow()} by ${userName}`,
        });
        downloadPdf(name, bytes);
      } else {
        // XLSX: the first column as real dates in Indian time; CSV and XLS keep the IST text.
        const body: Cell[][] = format === 'xlsx'
          ? r.rows.map((row, i) => [istWallClock(new Date(r.instants[i])), ...row.slice(1)])
          : r.rows;
        downloadExport(name, [{ name: 'Audit trail', rows: [r.header, ...body] }], format, password || undefined);
      }
      toast.success(`Exported ${r.rows.length.toLocaleString('en-IN')} event${r.rows.length === 1 ? '' : 's'}`, { description: `${name}.${password && format !== 'pdf' ? 'zip' : format}` });
      if (r.truncated) toast.info('The first 200,000 events are in the file. Narrow the dates for the rest.');
      onOpenChange(false);
    } catch (e) {
      toast.error('Not exported', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const shown = [
    `Period (IST): ${filters.from || 'the start'} to ${filters.to || 'today'}`,
    `Action: ${filters.action === 'all' ? 'all' : filters.action}`,
    `Record type: ${filters.targetType === 'all' ? 'all' : filters.targetType.replace(/[_-]/g, ' ')}`,
    ...(filters.actorUserId ? ['User: as chosen on screen'] : ['User: everyone']),
    ...(filters.search ? [`Search: "${filters.search}"`] : []),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-slot="audit-export-dialog">
        <DialogHeader>
          <DialogTitle>Export Audit Trail</DialogTitle>
          <DialogDescription>Every event the filters on screen find — not just the rows shown — with the date and time in IST, user, action, record, detail, reason, IP address, each field&apos;s old and new value, and what each deletion removed.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-[13px]">
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-[12px]" data-slot="audit-export-filters">
            <p className="mb-1 font-medium">Filters applied</p>
            <ul className="list-disc pl-4 text-muted-foreground">{shown.map((s) => <li key={s}>{s}</li>)}</ul>
          </div>
          <div className="space-y-1.5" role="radiogroup" aria-label="Export File Format">
            <p>Export File Format</p>
            {FORMATS.map(([v, l]) => (
              <label key={v} className="flex cursor-pointer items-center gap-2">
                <input type="radio" name="audit-export-format" className="size-3.5 accent-primary" checked={format === v} onChange={() => setFormat(v)} data-slot={`audit-format-${v}`} /> {l}
              </label>
            ))}
          </div>
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" className="size-3.5 accent-primary" checked={withIp} onChange={(e) => setWithIp(e.target.checked)} data-slot="audit-export-ip" />
            Include IP addresses (personal data)
          </label>
          {format !== 'pdf' && (
            <label className="block space-y-1">
              <span>File Protection Password (optional)</span>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" aria-label="File Protection Password" />
              <span className="block text-[12px] text-muted-foreground">With a password the file is put inside a password-protected zip.</span>
            </label>
          )}
        </div>
        <DialogFooter>
          <Button disabled={busy} onClick={() => void go()} data-slot="audit-export-go">{busy ? 'Exporting…' : 'Export'}</Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
