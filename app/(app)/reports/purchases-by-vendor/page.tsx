'use client';

// Spending ranked by supplier, net of GST.

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
      sublabel: `${r.count} bill${r.count === 1 ? '' : 's'}${state ? ` · ${state}` : ''}`,
      amountPaise: r.taxablePaise,
    };
  });
}

export default function PurchasesByVendorPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<SalesByReport>(
    () => reports.purchasesByVendor(range.from, range.to),
    [range.from, range.to],
  );

  return (
    <ReportShell
      title="Purchases by Vendor"
      description="Spending ranked by supplier, excluding GST. The top of this list is where negotiating better terms pays off most."
      range={range}
      onRangeChange={setRange}
      onExport={() => {
        if (!state.data) return;
        downloadCsv('purchases-by-vendor.csv', [
          ['Vendor', 'Detail', 'Net purchases'],
          ...toRanked(state.data).map((r) => [r.label, r.sublabel ?? '', toRupees(r.amountPaise)]),
        ]);
      }}
    >
      <AsyncPage state={state}>
        {(d) => <RankedReport rows={toRanked(d)} labelHeader="Vendor" valueHeader="Net purchases" />}
      </AsyncPage>
    </ReportShell>
  );
}
