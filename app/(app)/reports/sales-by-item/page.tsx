'use client';

// What actually sells — quantity beside value.
//
// Lines typed in by hand with no catalogue item behind them still count; they
// group under their own description rather than being dropped.

import { downloadCsv, ReportShell, useReportRange } from '@/components/shared/report-shell';
import { RankedReport, type RankedRow } from '@/components/shared/ranked-report';
import { AsyncPage } from '@/components/shared/async-state';
import { reports, type SalesByReport } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';

function toRanked(d: SalesByReport): RankedRow[] {
  return d.rows.map((r) => ({
    key: r.key,
    label: r.name,
    sublabel: r.detail ?? (r.key.startsWith('adhoc:') ? 'Ad-hoc line' : undefined),
    qty: r.qty,
    amountPaise: r.taxablePaise,
  }));
}

export default function SalesByItemPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<SalesByReport>(
    () => reports.salesBy('item', range.from, range.to),
    [range.from, range.to],
  );

  return (
    <ReportShell
      title="Sales by Item"
      description="What actually sells. Quantity and value side by side, so you can see the difference between what moves often and what earns most."
      range={range}
      onRangeChange={setRange}
      onExport={() => {
        if (!state.data) return;
        downloadCsv('sales-by-item.csv', [
          ['Item', 'Detail', 'Quantity', 'Net sales'],
          ...toRanked(state.data).map((r) => [r.label, r.sublabel ?? '', r.qty ?? 0, toRupees(r.amountPaise)]),
        ]);
      }}
    >
      <AsyncPage state={state}>
        {(d) => (
          <RankedReport rows={toRanked(d)} labelHeader="Item" valueHeader="Net sales" showQty qtyHeader="Qty sold" />
        )}
      </AsyncPage>
    </ReportShell>
  );
}
