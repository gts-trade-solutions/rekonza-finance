'use client';

// Revenue ranked by who generated it, net of GST.
//
// The state comes off the first two digits of the GSTIN, which is where the
// state code lives — no second lookup needed.

import { downloadCsv, ReportShell, useReportRange } from '@/components/shared/report-shell';
import { RankedReport, type RankedRow } from '@/components/shared/ranked-report';
import { AsyncPage } from '@/components/shared/async-state';
import { reports, type SalesByReport } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';
import { stateName } from '@/lib/tax/gst';

function toRanked(d: SalesByReport): RankedRow[] {
  return d.rows.map((r) => {
    const state = r.detail ? stateName(r.detail.slice(0, 2)) : '';
    return {
      key: r.key,
      label: r.name,
      sublabel: `${r.count} invoice${r.count === 1 ? '' : 's'}${state ? ` · ${state}` : ''}`,
      amountPaise: r.taxablePaise,
    };
  });
}

export default function SalesByCustomerPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<SalesByReport>(
    () => reports.salesBy('customer', range.from, range.to),
    [range.from, range.to],
  );

  return (
    <ReportShell
      title="Sales by Customer"
      description="Revenue ranked by who generated it, excluding GST. Useful for spotting concentration risk — if one customer is most of your revenue, that’s worth knowing."
      range={range}
      onRangeChange={setRange}
      onExport={() => {
        if (!state.data) return;
        downloadCsv('sales-by-customer.csv', [
          ['Customer', 'Detail', 'Net sales'],
          ...toRanked(state.data).map((r) => [r.label, r.sublabel ?? '', toRupees(r.amountPaise)]),
        ]);
      }}
    >
      <AsyncPage state={state}>
        {(d) => <RankedReport rows={toRanked(d)} labelHeader="Customer" valueHeader="Net sales" />}
      </AsyncPage>
    </ReportShell>
  );
}
