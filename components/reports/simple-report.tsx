'use client';

// One report page from the reports API: the period (or a date) picker, the
// grid with its totals, and the CSV. The pages for Zoho's longer report list
// (lib/server/reports/zoho-reports.ts) are each just their columns on this.

import type { ReactNode } from 'react';
import { downloadCsv, ReportShell, useReportRange } from '@/components/shared/report-shell';
import { ReportGrid, gridCsv, type GridColumn } from '@/components/shared/report-grid';
import { AsyncPage } from '@/components/shared/async-state';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

export interface SimpleReportData<Row> { report: string; rows: Row[]; [k: string]: unknown }

export function SimpleReport<Row>({ report, title, description, columns, empty, asOf = false, file, above }: {
  report: string;
  title: string;
  description: string;
  columns: GridColumn<Row>[];
  empty: string;
  /** A position at a date rather than a period. */
  asOf?: boolean;
  file?: string;
  /** Anything to show over the grid, from the whole reply (a total, a note). */
  above?: (data: SimpleReportData<Row>) => ReactNode;
}) {
  const [range, setRange] = useReportRange();
  const state = useApi<SimpleReportData<Row>>(
    () => api.get<SimpleReportData<Row>>('/api/reports', asOf ? { report, to: range.to } : { report, from: range.from, to: range.to }),
    [report, asOf ? '' : range.from, range.to],
  );
  return (
    <ReportShell
      title={title}
      description={description}
      range={range}
      onRangeChange={setRange}
      asOfOnly={asOf}
      onExport={() => {
        if (state.data) downloadCsv(`${file ?? report}.csv`, gridCsv(state.data.rows, columns));
      }}
    >
      <AsyncPage state={state}>
        {(d) => (
          <div className="space-y-3">
            {above?.(d)}
            <ReportGrid rows={d.rows} columns={columns} emptyMessage={empty} />
          </div>
        )}
      </AsyncPage>
    </ReportShell>
  );
}
