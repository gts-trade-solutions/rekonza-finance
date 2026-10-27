'use client';

// The handful of numbers a lender or an accountant checks first.
//
// Each carries the plain-English reason it matters, because a ratio you cannot
// interpret is not information. The colour is a rule of thumb, not a verdict:
// what counts as a healthy margin differs enormously by trade.

import { Card } from '@/components/ui/card';
import { downloadCsv, ReportShell, useReportRange } from '@/components/shared/report-shell';
import { AsyncPage } from '@/components/shared/async-state';
import { reports, type BusinessRatiosReport } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { cn } from '@/lib/utils';

type Ratio = BusinessRatiosReport['ratios'][number];

function format(r: Ratio): string {
  if (r.unit === 'pct') return `${r.value.toFixed(1)}%`;
  if (r.unit === 'days') return `${Math.round(r.value)} days`;
  return r.value.toFixed(2);
}

const tone = (good: boolean | null) =>
  good === null ? 'text-foreground' : good ? 'text-success' : 'text-warning';

export default function BusinessRatiosPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<BusinessRatiosReport>(
    () => reports.businessRatios(range.from, range.to),
    [range.from, range.to],
  );

  return (
    <ReportShell
      title="Business Performance Ratios"
      description="The handful of numbers a lender or an accountant checks first. Each is explained in plain terms, because a ratio you cannot interpret is not information."
      range={range}
      onRangeChange={setRange}
      onExport={() => {
        if (!state.data) return;
        downloadCsv('business-ratios.csv', [
          ['Ratio', 'Value', 'What it means'],
          ...state.data.ratios.map((r) => [r.label, format(r), r.explain]),
        ]);
      }}
    >
      <AsyncPage state={state}>
        {(d) => (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {d.ratios.map((r) => (
              <Card key={r.key} className="accent-bar p-4">
                <p className="text-[13px] text-muted-foreground">{r.label}</p>
                <p className={cn('mt-1 text-2xl font-semibold tabular', tone(r.good))}>{format(r)}</p>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{r.explain}</p>
              </Card>
            ))}
          </div>
        )}
      </AsyncPage>
    </ReportShell>
  );
}
