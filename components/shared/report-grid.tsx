'use client';

// A plain tabular report: columns in, rows out, optional totals row, CSV export
// wired from the same column definitions. Every Zoho-style detail report is one
// of these, so they all sort, align and export identically.

import type { ReactNode } from 'react';
import { ReportTable } from '@/components/shared/report-shell';
import { cn } from '@/lib/utils';

export interface GridColumn<T> {
  key: string;
  header: string;
  align?: 'left' | 'right' | 'center';
  /** On-screen cell. */
  cell: (row: T) => ReactNode;
  /** Value written to CSV; falls back to the cell when it is a plain string. */
  csv?: (row: T) => string | number;
  /** Footer value for this column, when the report has a totals row. */
  total?: (rows: T[]) => ReactNode;
  className?: string;
}

export function ReportGrid<T>({
  rows,
  columns,
  emptyMessage = 'Nothing to show for this period.',
  showTotals = true,
  totalsLabel = 'Total',
}: {
  rows: T[];
  columns: GridColumn<T>[];
  emptyMessage?: string;
  showTotals?: boolean;
  totalsLabel?: string;
}) {
  const hasTotals = showTotals && columns.some((c) => c.total);

  return (
    <ReportTable>
      <thead>
        <tr className="border-b bg-muted/50">
          {columns.map((c) => (
            <th
              key={c.key}
              className={cn(
                'px-4 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground',
                c.align === 'right' && 'text-right',
                c.align === 'center' && 'text-center',
              )}
            >
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={columns.length} className="px-4 py-12 text-center text-sm text-muted-foreground">
              {emptyMessage}
            </td>
          </tr>
        ) : (
          rows.map((row, i) => (
            <tr key={i} className="border-b last:border-0 hover:bg-accent/40">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cn(
                    'px-4 py-2',
                    c.align === 'right' && 'text-right',
                    c.align === 'center' && 'text-center',
                    c.className,
                  )}
                >
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))
        )}
        {hasTotals && rows.length > 0 && (
          <tr className="border-t-2 bg-muted/40 font-semibold">
            {columns.map((c, idx) => (
              <td
                key={c.key}
                className={cn(
                  'px-4 py-3',
                  c.align === 'right' && 'text-right',
                  c.align === 'center' && 'text-center',
                )}
              >
                {c.total ? c.total(rows) : idx === 0 ? totalsLabel : null}
              </td>
            ))}
          </tr>
        )}
      </tbody>
    </ReportTable>
  );
}

/** Build the CSV matrix for a grid from the same column definitions. */
export function gridCsv<T>(rows: T[], columns: GridColumn<T>[]): (string | number)[][] {
  return [
    columns.map((c) => c.header),
    ...rows.map((r) => columns.map((c) => (c.csv ? c.csv(r) : ''))),
  ];
}
