'use client';

// Fund flow statement: the long-term view beside the cash flow. Where funds
// came from over the period — operations, owners, borrowing, assets sold —
// and what they went into, with the change in working capital scheduled item
// by item underneath (lib/server/reports/fund-flow.ts).

import { Card } from '@/components/ui/card';
import { Money } from '@/components/shared/money';
import { downloadCsv, ReportShell, ReportTable, useReportRange } from '@/components/shared/report-shell';
import { AsyncPage } from '@/components/shared/async-state';
import { reports, type FundFlowReport } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';

export default function FundFlowPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<FundFlowReport>(() => reports.fundFlow(range.from, range.to), [range.from, range.to]);

  return (
    <ReportShell
      title="Fund Flow Statement"
      description="Where the business's funds came from over the period and what they were applied to. Working capital — current assets less current liabilities — is the balancing figure, scheduled below."
      range={range}
      onRangeChange={setRange}
      onExport={() => {
        const d = state.data;
        if (!d) return;
        downloadCsv('fund-flow.csv', [
          ['Sources of funds', ''], ...d.sources.map((l) => [l.label, toRupees(l.amountPaise)]), ['Total sources', toRupees(d.totalSourcesPaise)], [],
          ['Applications of funds', ''], ...d.applications.map((l) => [l.label, toRupees(l.amountPaise)]), ['Total applications', toRupees(d.totalApplicationsPaise)], [],
          ['Schedule of changes in working capital', 'Opening', 'Closing', 'Increase', 'Decrease'],
          ...d.workingCapital.lines.map((l) => [l.label, toRupees(l.openingPaise), toRupees(l.closingPaise), toRupees(l.increasePaise), toRupees(l.decreasePaise)]),
          ['Working capital', toRupees(d.workingCapital.openingPaise), toRupees(d.workingCapital.closingPaise)],
        ]);
      }}
    >
      <AsyncPage state={state}>
        {(d) => (
          <>
            {!d.balanced && <p className="text-sm text-destructive">Sources and applications differ; the balance sheet for one of the dates does not balance.</p>}
            <div className="grid gap-4 lg:grid-cols-2">
              {([['Sources of funds', d.sources, d.totalSourcesPaise], ['Applications of funds', d.applications, d.totalApplicationsPaise]] as const).map(([title, lines, total]) => (
                <ReportTable key={title}>
                  <thead className="bg-muted/40 text-xs text-muted-foreground">
                    <tr><th className="px-3 py-2 text-left font-medium">{title}</th><th className="px-3 py-2 text-right font-medium">₹</th></tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.label} className="border-t"><td className="px-3 py-2">{l.label}</td><td className="px-3 py-2 text-right"><Money value={l.amountPaise} /></td></tr>
                    ))}
                    {!lines.length && <tr className="border-t"><td className="px-3 py-2 text-muted-foreground" colSpan={2}>None in the period.</td></tr>}
                    <tr className="border-t bg-muted/30 font-semibold"><td className="px-3 py-2">Total</td><td className="px-3 py-2 text-right"><Money value={total} /></td></tr>
                  </tbody>
                </ReportTable>
              ))}
            </div>
            <Card className="p-4 text-sm">
              <p className="font-medium">Funds from operations</p>
              <p className="mt-1 text-muted-foreground">
                Profit <Money value={d.operations.profitPaise} /> + depreciation <Money value={d.operations.depreciationPaise} />
                {d.operations.lossOnSalePaise ? <> + loss on assets sold <Money value={d.operations.lossOnSalePaise} /></> : null}
                {' '}= <Money value={d.operations.totalPaise} className="font-medium text-foreground" />. Depreciation is a charge against profit that moves no funds, so it is added back.
              </p>
            </Card>
            <ReportTable>
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Schedule of changes in working capital</th>
                  <th className="px-3 py-2 text-right font-medium">Opening</th>
                  <th className="px-3 py-2 text-right font-medium">Closing</th>
                  <th className="px-3 py-2 text-right font-medium">Increase</th>
                  <th className="px-3 py-2 text-right font-medium">Decrease</th>
                </tr>
              </thead>
              <tbody>
                {d.workingCapital.lines.map((l) => (
                  <tr key={l.label} className="border-t">
                    <td className="px-3 py-2">{l.label}</td>
                    <td className="px-3 py-2 text-right"><Money value={l.openingPaise} /></td>
                    <td className="px-3 py-2 text-right"><Money value={l.closingPaise} /></td>
                    <td className="px-3 py-2 text-right"><Money value={l.increasePaise} showZero={false} /></td>
                    <td className="px-3 py-2 text-right"><Money value={l.decreasePaise} showZero={false} /></td>
                  </tr>
                ))}
                <tr className="border-t bg-muted/30 font-semibold">
                  <td className="px-3 py-2">Working capital</td>
                  <td className="px-3 py-2 text-right"><Money value={d.workingCapital.openingPaise} /></td>
                  <td className="px-3 py-2 text-right"><Money value={d.workingCapital.closingPaise} /></td>
                  <td className="px-3 py-2 text-right" colSpan={2}>
                    {d.workingCapital.changePaise >= 0 ? 'Increase ' : 'Decrease '}<Money value={Math.abs(d.workingCapital.changePaise)} />
                  </td>
                </tr>
              </tbody>
            </ReportTable>
          </>
        )}
      </AsyncPage>
    </ReportShell>
  );
}
