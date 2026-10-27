'use client';

// Common chrome for every report: date range, export, print, and the
// "this is derived from N journal entries" provenance line.

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, Download, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { useAppStore } from '@/lib/store';
import { today } from '@/lib/selectors';
import { DateRangePicker } from '@/components/shared/date-range-picker';
import { COMPARE_LABEL, describeRangeLong, fromPreset, type CompareMode, type RangeValue } from '@/lib/date-range';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { downloadWorkbook } from '@/lib/xlsx';
import { allowOutput, printPage } from '@/lib/output-guard';

export type { DateRange } from '@/lib/date-range';

/**
 * Reports open on the current financial year, because that is the period a
 * report is almost always wanted for and it matches the figures the org's
 * returns are filed against. A report opened from another one's figure is
 * handed that figure's range instead.
 */
export function useReportRange(initial?: { from?: string | null; to?: string | null }): [RangeValue, (r: RangeValue) => void] {
  const [range, setRange] = useState<RangeValue>(() =>
    initial?.from && initial.to ? { from: initial.from, to: initial.to, mode: 'custom' } : fromPreset('this_fy', today()));
  return [range, setRange];
}

/** What a report sets its figures beside: nothing, the period before, or the same period last year. */
export function CompareSelect({ value, onChange }: { value: CompareMode; onChange: (v: CompareMode) => void }) {
  return (
    <div className="space-y-1">
      <label className="text-[11px] font-medium text-muted-foreground">Compare with</label>
      <select value={value} onChange={(e) => onChange(e.target.value as CompareMode)}
        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
        {(Object.keys(COMPARE_LABEL) as CompareMode[]).map((k) => <option key={k} value={k}>{COMPARE_LABEL[k]}</option>)}
      </select>
    </div>
  );
}

/**
 * What the next export is for. Every report builds its rows and hands them to
 * downloadCsv; the Export menu sets this first, so choosing Excel gets the same
 * rows as a workbook without thirty reports each learning a second format.
 */
let nextExport: { as: 'xlsx'; title: string } | null = null;

const NUMBER = /^-?\d+(\.\d+)?$/;

/** Download any table as CSV — or Excel, when chosen from the Export menu. */
export function downloadCsv(filename: string, rows: (string | number)[][]) {
  if (!allowOutput('export', filename)) return;
  if (nextExport) {
    const { title } = nextExport;
    nextExport = null;
    // Figures a report formats as text go in as numbers, so the sheet adds up.
    downloadWorkbook(filename.replace(/\.csv$/i, ''), [{
      name: title,
      // A code with a leading zero — HSN 0401, a PIN — stays text.
      rows: rows.map((r) => r.map((c) => (typeof c === 'string' && !/^-?0\d/.test(c) && NUMBER.test(c.replace(/,/g, '')) ? Number(c.replace(/,/g, '')) : c))),
    }]);
    return;
  }
  const csv = rows
    .map((r) => r.map((c) => (typeof c === 'string' && /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** A file to upload somewhere else, such as the GST portal. */
export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ReportShell({
  title,
  description,
  range,
  onRangeChange,
  showRange = true,
  asOfOnly = false,
  onExport,
  children,
  extraActions,
  dataDates,
}: {
  title: string;
  description: string;
  range?: RangeValue;
  onRangeChange?: (r: RangeValue) => void;
  showRange?: boolean;
  asOfOnly?: boolean;
  onExport?: () => void;
  children: ReactNode;
  extraActions?: ReactNode;
  /** Transaction dates, so the picker only offers financial years with data. */
  dataDates?: string[];
}) {
  const s = useAppStore();

  return (
    <>
      <div className="no-print space-y-4">
        <Button variant="ghost" size="sm" asChild className="-ml-2 gap-1.5">
          <Link href="/reports"><ArrowLeft className="size-3.5" /> All reports</Link>
        </Button>

        <div className="flex flex-col gap-3 border-b pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            {showRange && range && onRangeChange && (
              asOfOnly ? (
                // A balance sheet is a snapshot, not a period — offering a
                // range here would invite a question the report cannot answer.
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-muted-foreground">As at</label>
                  <Input
                    type="date"
                    value={range.to}
                    onChange={(e) => onRangeChange({ ...range, to: e.target.value, mode: 'day' })}
                    className="h-9 w-40"
                  />
                </div>
              ) : (
                <DateRangePicker
                  value={range}
                  onChange={onRangeChange}
                  dataDates={dataDates}
                  label="Period"
                />
              )
            )}
            {extraActions}
            {onExport && (
              <DropdownMenu>
                <DropdownMenuTrigger className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-muted">
                  <Download className="size-3.5" /> Export
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => { nextExport = { as: 'xlsx', title }; try { onExport(); } finally { nextExport = null; } }}>
                    Excel (.xlsx)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { nextExport = null; onExport(); }}>CSV</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button variant="outline" size="sm" onClick={() => printPage()} className="gap-1.5">
              <Printer className="size-3.5" /> Print
            </Button>
          </div>
        </div>
      </div>

      {/* Print header */}
      <div className="print-only mb-4 border-b pb-3">
        <p className="text-lg font-bold">{s.org?.name}</p>
        <p className="text-sm font-semibold">{title}</p>
        {range && (
          <p className="text-xs text-neutral-600">
            {asOfOnly
              ? `As at ${new Date(range.to).toLocaleDateString('en-IN')}`
              : describeRangeLong(range)}
          </p>
        )}
      </div>

      {children}

      <p className="no-print text-xs text-muted-foreground">
        Derived live from the journal on every request. Nothing on this page is stored — change a
        document and this report changes with it.
      </p>
    </>
  );
}

/** Standard report table wrapper. */
export function ReportTable({ children }: { children: ReactNode }) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="overflow-x-auto thin-scroll">
        <table className="w-full text-sm">{children}</table>
      </div>
    </Card>
  );
}
