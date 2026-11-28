'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Reversed vouchers: every reversal pair in the books — journals, and the
// invoices, bills, receipts, payments and transfers undone by voiding or
// deleting them — with the reason and who asked for it and who approved it,
// plus the reversals still to come (waiting for a second person under a
// journal approval rule, or an accrual due to reverse itself on a later date).
//
// An auditor tests reversals from here: each line shows "#9 reversed by #10",
// both open in the journal, and the reason is the one kept in the audit trail.
// Nothing is ever deleted from the ledger; this is the list of corrections.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { History } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { AsyncPage } from '@/components/shared/async-state';
import { EmptyState } from '@/components/shared/empty-state';
import { Money } from '@/components/shared/money';
import { DateRangePicker } from '@/components/shared/date-range-picker';
import { downloadCsv, useReportRange } from '@/components/shared/report-shell';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { voucherReversals, type ReversalPairRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { sourceHref } from '@/lib/source-links';
import { toRupees } from '@/lib/money';
import { downloadWorkbook } from '@/lib/xlsx';
import { downloadPdf, istNow, pdfTable } from '@/lib/pdf';
import { allowOutput } from '@/lib/output-guard';
import { useAppStore } from '@/lib/store';

const KIND: Record<ReversalPairRow['kind'], { label: string; tone: string }> = {
  manual: { label: 'Reversed by hand', tone: '' },
  approved: { label: 'Approved by a second person', tone: 'border-blue-500/40 text-blue-700 dark:text-blue-300' },
  scheduled: { label: 'Auto-reversing journal', tone: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300' },
  document: { label: 'Document voided or deleted', tone: 'border-muted-foreground/30 text-muted-foreground' },
  waiting_approval: { label: 'Waiting for approval', tone: 'border-amber-500/50 text-amber-700 dark:text-amber-300' },
  scheduled_pending: { label: 'Due to reverse', tone: 'border-amber-500/50 text-amber-700 dark:text-amber-300' },
};

const dmy = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const source = (t: string) => t.replace(/_/g, ' ');

export default function ReversedVouchersPage() {
  const [range, setRange] = useReportRange();
  const org = useAppStore((s) => s.org?.name ?? '');
  const state = useApi(() => voucherReversals.register({ from: range.from, to: range.to }), [range.from, range.to]);

  const header = ['Original entry', 'Original date', 'Source', 'Narration', 'Reversal entry', 'Reversal date', 'Amount', 'Reason', 'Asked for by', 'Approved by', 'How'];
  const rowsOf = (pairs: ReversalPairRow[]) => pairs.map((p) => [
    `#${p.entryNo}`, p.entryDate, source(p.sourceType), p.memo ?? '', p.reversalNo ? `#${p.reversalNo}` : p.kind === 'waiting_approval' ? `H-${p.heldId} (waiting)` : `H-${p.heldId} (due)`,
    p.reversalDate ?? '', toRupees(p.amountPaise), p.reason ?? '', p.requestedBy ?? '', p.approvedBy ?? '', KIND[p.kind].label,
  ]);
  const title = `Reversed vouchers ${range.from} to ${range.to}`;
  const exportAs = (as: 'xlsx' | 'csv' | 'pdf') => {
    const pairs = state.data?.pairs ?? [];
    const rows = rowsOf(pairs);
    if (as === 'csv') { downloadCsv(`${title}.csv`, [[title], header, ...rows]); return; }
    if (as === 'xlsx') { downloadWorkbook(title, [{ name: 'Reversed vouchers', rows: [header, ...rows.map((r) => r.map((c, i) => (i === 6 ? Number(c) : c)))] }]); return; }
    if (!allowOutput('export', title)) return;
    downloadPdf(title, pdfTable({
      title: 'Reversed vouchers', org, landscape: true,
      lines: [`Reversals dated ${dmy(range.from)} to ${dmy(range.to)}, and those still waiting for approval or their date.`, `${pairs.length} line${pairs.length === 1 ? '' : 's'}.`],
      columns: header.map((h, i) => ({ header: h, width: [0.8, 0.9, 0.9, 2, 1, 0.9, 0.9, 2.2, 1, 1, 1.3][i] })),
      rows, footer: `Exported ${istNow()}`,
    }));
  };

  const columns: Column<ReversalPairRow>[] = [
    {
      key: 'original', header: 'Original', sortValue: (r) => r.entryNo,
      cell: (r) => (
        <div>
          <Link href={`/reports/journal-report?source=reversals&from=${r.entryDate}&to=${r.reversalDate && r.reversalDate > r.entryDate ? r.reversalDate : r.entryDate}`} className="font-mono font-medium hover:underline" data-slot="rv-original">#{r.entryNo}</Link>
          <span className="ml-2 text-xs text-muted-foreground">{dmy(r.entryDate)}</span>
          <p className="text-xs capitalize text-muted-foreground">
            {sourceHref(r.sourceType, r.sourceId) ? <Link href={sourceHref(r.sourceType, r.sourceId)!} className="hover:underline">{source(r.sourceType)}</Link> : source(r.sourceType)}
            {r.memo ? <span className="normal-case"> · {r.memo}</span> : null}
          </p>
        </div>
      ),
      className: 'whitespace-normal max-w-xs',
    },
    {
      key: 'reversal', header: 'Reversed by', sortValue: (r) => r.reversalDate ?? '',
      cell: (r) => r.reversalNo ? (
        <div>
          <span className="font-mono font-medium" data-slot="rv-reversal">#{r.reversalNo}</span>
          <span className="ml-2 text-xs text-muted-foreground">{dmy(r.reversalDate)}</span>
        </div>
      ) : (
        <div className="text-xs">
          <span className="font-medium">{r.kind === 'waiting_approval' ? 'Not yet: waiting for approval' : `Due on ${dmy(r.reversalDate)}`}</span>
          <p className="text-muted-foreground">Held entry H-{r.heldId}{r.kind === 'waiting_approval' ? <> · <Link href="/approvals" className="text-primary hover:underline">Open approvals</Link></> : null}</p>
        </div>
      ),
    },
    { key: 'amount', header: 'Amount', align: 'right', sortValue: (r) => r.amountPaise, cell: (r) => <Money value={r.amountPaise} className="font-medium" /> },
    { key: 'reason', header: 'Reason', sortValue: (r) => r.reason ?? '', cell: (r) => <span className="text-sm" data-slot="rv-reason">{r.reason ?? <span className="text-muted-foreground">Not given</span>}</span>, className: 'whitespace-normal max-w-sm' },
    {
      key: 'who', header: 'Who', sortValue: (r) => r.requestedBy ?? '',
      cell: (r) => (
        <div className="text-xs">
          <p>{r.requestedBy ?? 'System'}</p>
          {r.approvedBy && <p className="text-muted-foreground">approved by {r.approvedBy}</p>}
        </div>
      ),
    },
    { key: 'kind', header: 'How', sortValue: (r) => r.kind, cell: (r) => <Badge variant="outline" className={`text-[10px] ${KIND[r.kind].tone}`}>{KIND[r.kind].label}</Badge> },
  ];

  return (
    <>
      <PageHeader
        title="Reversed Vouchers"
        description="Every reversal in the books with its reason and who did it: journals reversed, and invoices, bills, receipts, payments and transfers voided or deleted. Nothing is ever removed from the ledger; each correction is its own entry."
        actions={(
          <div className="flex flex-wrap items-end gap-2">
            <DateRangePicker value={range} onChange={setRange} label="Reversal date" />
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-muted" data-slot="rv-export">Export</DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => exportAs('xlsx')}>Excel (.xlsx)</DropdownMenuItem>
                <DropdownMenuItem onClick={() => exportAs('csv')}>CSV</DropdownMenuItem>
                <DropdownMenuItem onClick={() => exportAs('pdf')} data-slot="rv-export-pdf">PDF</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm" variant="outline" asChild><Link href="/accountant/journals">Manual Journals</Link></Button>
          </div>
        )}
      />
      {/* One paragraph: a Card lays its children out as a column, which broke the sentence around "Reverse". */}
      <Card className="p-3 text-xs text-muted-foreground">
        <p data-slot="rv-howto">
          To reverse a journal: Accountant → Manual Journals → the journal → <span className="font-medium text-foreground">Reverse</span>, with a date and a reason.
          A date in a locked period or a closed year is refused and the first open date is offered. Where a journal approval rule covers the amount,
          the reversal waits under Approvals for someone else. An invoice, bill, receipt, payment or transfer is reversed by voiding or deleting it on its own screen,
          and that window asks for the reason shown here.
        </p>
      </Card>
      <AsyncPage state={state}>
        {(d) => d.pairs.length === 0 ? (
          <EmptyState icon={History} title="No reversals in this period"
            description="When a journal is reversed, or a document voided or deleted, the pair appears here with its reason. Widen the dates, or reverse a journal from Manual Journals." />
        ) : (
          <DataTable rows={d.pairs} columns={columns} getRowId={(r) => `${r.entryId}-${r.reversalId ?? r.heldId}`} initialSort={{ key: 'reversal', dir: 'desc' }}
            searchPlaceholder="Search reasons, narrations…" emptyMessage="Nothing matches." />
        )}
      </AsyncPage>
    </>
  );
}
