'use client';

// Direct-method cash flow.
//
// Every movement through a bank or cash account, classified by what the other
// side of the entry was. Profit is an opinion — it counts an invoice the day
// you raise it. Cash is a fact, and this is the statement that tracks it.
//
// The three activity groups are the standard ones: operating is the trading the
// business does, investing is buying and selling long-lived assets, financing
// is the owners putting money in or taking it out.

import { Card } from '@/components/ui/card';
import { Money } from '@/components/shared/money';
import { downloadCsv, ReportShell, ReportTable, useReportRange } from '@/components/shared/report-shell';
import { AsyncPage } from '@/components/shared/async-state';
import { reports, type CashFlowReport } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';

const GROUPS = ['Operating', 'Investing', 'Financing'] as const;

const GROUP_TOTAL: Record<string, (d: CashFlowReport) => number> = {
  Operating: (d) => d.operatingPaise,
  Investing: (d) => d.investingPaise,
  Financing: (d) => d.financingPaise,
};

export default function CashFlowPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<CashFlowReport>(
    () => reports.cashFlow(range.from, range.to),
    [range.from, range.to],
  );

  return (
    <ReportShell
      title="Cash Flow"
      description="Profit is an opinion; cash is a fact. This traces every rupee that actually entered or left your bank and cash accounts, grouped by what caused it."
      range={range}
      onRangeChange={setRange}
      onExport={() => {
        const d = state.data;
        if (!d) return;
        downloadCsv('cash-flow.csv', [
          ['Activity', 'Group', 'Net'],
          ['Opening cash', '', toRupees(d.openingPaise)],
          ...d.rows.map((r) => [r.label, r.group, toRupees(r.amountPaise)]),
          ['Closing cash', '', toRupees(d.closingPaise)],
        ]);
      }}
    >
      <AsyncPage state={state}>
        {(d) => {
          const net = d.closingPaise - d.openingPaise;
          return (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Card className="p-4">
                  <p className="text-xs text-muted-foreground">Opening cash</p>
                  <Money value={d.openingPaise} className="mt-1 block text-2xl font-semibold" />
                </Card>
                <Card className={'p-4 ' + (net >= 0 ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-destructive/40 bg-destructive/5')}>
                  <p className="text-xs text-muted-foreground">Net movement</p>
                  <Money value={net} className="mt-1 block text-2xl font-semibold" />
                </Card>
                <Card className="p-4">
                  <p className="text-xs text-muted-foreground">Closing cash</p>
                  <Money value={d.closingPaise} className="mt-1 block text-2xl font-semibold" />
                </Card>
              </div>

              <ReportTable>
                <thead>
                  <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 text-left font-semibold">Activity</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Net movement</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b bg-muted/20 font-medium">
                    <td className="px-4 py-2.5">Cash at start of period</td>
                    <td className="px-4 py-2.5 text-right"><Money value={d.openingPaise} /></td>
                  </tr>

                  {GROUPS.flatMap((g) => {
                    const rows = d.rows.filter((r) => r.group === g);
                    if (!rows.length) return [];
                    return [
                      <tr key={`${g}-head`} className="border-b bg-muted/30">
                        <td className="px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground" colSpan={2}>
                          {g} activities
                        </td>
                      </tr>,
                      ...rows.map((r) => (
                        <tr key={`${g}-${r.label}`} className="border-b hover:bg-accent/40">
                          <td className="px-4 py-2 pl-8">{r.label}</td>
                          <td className="px-4 py-2 text-right"><Money value={r.amountPaise} colored /></td>
                        </tr>
                      )),
                      <tr key={`${g}-total`} className="border-b bg-muted/20 font-medium">
                        <td className="px-4 py-2">Net cash from {g.toLowerCase()} activities</td>
                        <td className="px-4 py-2 text-right"><Money value={GROUP_TOTAL[g](d)} colored /></td>
                      </tr>,
                    ];
                  })}

                  <tr className="border-t-2 bg-muted/40 font-semibold">
                    <td className="px-4 py-3">Cash at end of period</td>
                    <td className="px-4 py-3 text-right"><Money value={d.closingPaise} /></td>
                  </tr>
                </tbody>
              </ReportTable>
            </>
          );
        }}
      </AsyncPage>
    </ReportShell>
  );
}
