'use client';

// TDS — tax deducted at source, in both directions.
//
// The two sides are opposites in every sense. What we deduct from a supplier is
// a liability: we are holding the government's money and must deposit it by the
// 7th of the following month. What a customer deducts from us is an asset —
// they have already paid it on our behalf, and it comes back as credit against
// our own income tax when we file.
//
// The period defaults to the financial year, not the month, because every TDS
// threshold is annual. A monthly view cannot tell you whether one was crossed.

import { useState } from 'react';
import Link from 'next/link';
import { Download, Receipt, TrendingDown, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { StatTile } from '@/components/shared/stat-tile';
import { AsyncPage } from '@/components/shared/async-state';
import { downloadCsv } from '@/components/shared/report-shell';
import { gst, type TdsResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { TdsQuarterReturn } from '@/components/gst/tds-quarter-return';
import { LowerDeductionPanel, PanCheckPanel, TdsCertificatesPanel } from '@/components/gst/tds-certificates';
import { formatINRCompact, toRupees } from '@/lib/money';

const short = (d: string) => new Date(d).toLocaleDateString('en-IN');

/** '2026-27' for any date in the 2026-27 financial year. */
function fyLabel(from: string): string {
  const y = Number(from.slice(0, 4));
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

export default function TdsTcsPage() {
  const [tab, setTab] = useState('deducted');
  const state = useApi<TdsResponse>(() => gst.tds(), []);

  const exportCsv = (d: TdsResponse) => {
    downloadCsv(`tds-${fyLabel(d.from)}.csv`, [
      ['Section', 'Deductee', 'PAN', 'Bills', 'Taxable', 'TDS', 'Effective rate %'],
      ...d.deducted.map((r) => [
        r.section, r.vendorName, r.pan ?? '', r.billCount,
        toRupees(r.taxablePaise), toRupees(r.tdsPaise), r.ratePct.toFixed(2),
      ]),
    ]);
    toast.success('TDS register exported', {
      description: 'The columns line up with what a 26Q return needs.',
    });
  };

  return (
    <>
      <PageHeader
        title="TDS & TCS"
        description="Tax withheld on payments — what you owe the government, and what your customers have already paid on your behalf."
        actions={
          state.data && (
            <Button size="sm" className="gap-1.5" onClick={() => exportCsv(state.data!)}>
              <Download className="size-3.5" /> Export register
            </Button>
          )
        }
      />

      <AsyncPage state={state}>
        {(d) => (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <StatTile
                label="TDS you deducted"
                value={formatINRCompact(d.deductedTotalPaise)}
                sub="Owed to the government by the 7th"
                icon={TrendingDown}
                tone={d.deductedTotalPaise > 0 ? 'warning' : 'default'}
              />
              <StatTile
                label="TDS withheld from you"
                value={formatINRCompact(d.withheldByCustomersPaise)}
                sub="Reclaimable against your income tax"
                icon={TrendingUp}
                tone="positive"
              />
              <StatTile
                label="Period"
                value={`FY ${fyLabel(d.from)}`}
                sub={`${short(d.from)} – ${short(d.to)}`}
                icon={Receipt}
              />
            </div>

            <Tabs value={tab} onValueChange={setTab}>
              <TabsList>
                <TabsTrigger value="deducted">You deducted ({d.deducted.length})</TabsTrigger>
                <TabsTrigger value="withheld">Withheld from you ({d.withheldRows.length})</TabsTrigger>
                <TabsTrigger value="return">Quarterly return & challans</TabsTrigger>
                <TabsTrigger value="certificates">Certificates</TabsTrigger>
                <TabsTrigger value="lower">Lower deduction</TabsTrigger>
                <TabsTrigger value="pans">PAN check</TabsTrigger>
                <TabsTrigger value="sections">Sections & thresholds</TabsTrigger>
              </TabsList>

              <TabsContent value="deducted" className="mt-4 space-y-3">
                <p className="text-xs text-muted-foreground">
                  A liability, not an expense. The money is the supplier&apos;s — you are holding it on the
                  government&apos;s behalf and must deposit it by the 7th of the following month, then report it in
                  the quarterly 26Q.
                </p>
                <div className="overflow-x-auto rounded-lg border thin-scroll">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-2 text-left font-semibold">Section</th>
                        <th className="px-3 py-2 text-left font-semibold">Deductee</th>
                        <th className="px-3 py-2 text-left font-semibold">PAN</th>
                        <th className="px-3 py-2 text-right font-semibold">Bills</th>
                        <th className="px-3 py-2 text-right font-semibold">Taxable</th>
                        <th className="px-3 py-2 text-right font-semibold">TDS</th>
                        <th className="px-3 py-2 text-right font-semibold">Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.deducted.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="px-3 py-8 text-center text-sm text-muted-foreground">
                            No TDS deducted this year. Thresholds are annual — nothing has crossed one yet.
                          </td>
                        </tr>
                      ) : (
                        d.deducted.map((r) => (
                          <tr key={`${r.vendorId}-${r.section}`} className="border-b last:border-0 hover:bg-accent/40">
                            <td className="px-3 py-2">
                              <Badge variant="secondary" className="text-[10px]">{r.section}</Badge>
                            </td>
                            <td className="px-3 py-2 font-medium">{r.vendorName}</td>
                            <td className="px-3 py-2 font-mono text-[10px]">
                              {r.pan ?? (
                                <span className="text-destructive">No PAN — 20%</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right tabular text-xs">{r.billCount}</td>
                            <td className="px-3 py-2 text-right"><Money value={r.taxablePaise} /></td>
                            <td className="px-3 py-2 text-right"><Money value={r.tdsPaise} className="font-medium" /></td>
                            <td className="px-3 py-2 text-right tabular text-xs">{r.ratePct.toFixed(2)}%</td>
                          </tr>
                        ))
                      )}
                      {d.deducted.length > 0 && (
                        <tr className="border-t-2 bg-muted/40 font-semibold">
                          <td className="px-3 py-2.5" colSpan={5}>Total to deposit</td>
                          <td className="px-3 py-2.5 text-right"><Money value={d.deductedTotalPaise} /></td>
                          <td />
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </TabsContent>

              <TabsContent value="withheld" className="mt-4 space-y-3">
                <p className="text-xs text-muted-foreground">
                  An asset, not lost income. A customer who deducts TDS has still settled the invoice in full — part
                  of it went to the government instead of to you, and it comes back as credit when you file. It sits
                  in TDS Receivable until then.
                </p>
                <div className="overflow-x-auto rounded-lg border thin-scroll">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-2 text-left font-semibold">Receipt</th>
                        <th className="px-3 py-2 text-left font-semibold">Date</th>
                        <th className="px-3 py-2 text-left font-semibold">Customer</th>
                        <th className="px-3 py-2 text-right font-semibold">Cash received</th>
                        <th className="px-3 py-2 text-right font-semibold">TDS withheld</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.withheldRows.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="px-3 py-8 text-center text-sm text-muted-foreground">
                            No customer has withheld tax this year.
                          </td>
                        </tr>
                      ) : (
                        d.withheldRows.map((r) => (
                          <tr key={r.paymentId} className="border-b last:border-0 hover:bg-accent/40">
                            <td className="px-3 py-2 font-medium">{r.number}</td>
                            <td className="px-3 py-2 text-xs">{short(r.date)}</td>
                            <td className="px-3 py-2">{r.customerName}</td>
                            <td className="px-3 py-2 text-right"><Money value={r.amountPaise} /></td>
                            <td className="px-3 py-2 text-right"><Money value={r.tdsPaise} className="font-medium" /></td>
                          </tr>
                        ))
                      )}
                      {d.withheldRows.length > 0 && (
                        <tr className="border-t-2 bg-muted/40 font-semibold">
                          <td className="px-3 py-2.5" colSpan={4}>Total reclaimable</td>
                          <td className="px-3 py-2.5 text-right"><Money value={d.withheldByCustomersPaise} /></td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </TabsContent>

              <TabsContent value="return" className="mt-4 space-y-3">
                <TdsQuarterReturn />
              </TabsContent>

              <TabsContent value="certificates" className="mt-4">
                <TdsCertificatesPanel />
              </TabsContent>

              <TabsContent value="lower" className="mt-4">
                <LowerDeductionPanel />
              </TabsContent>

              <TabsContent value="pans" className="mt-4">
                <PanCheckPanel />
              </TabsContent>

              <TabsContent value="sections" className="mt-4 space-y-3">
                <div className="rounded-lg border p-4 text-sm">
                  <p className="font-medium">Rates and thresholds are kept by date</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Each bill is deducted at the rate in force on its own date, from this book&apos;s rate table. Review
                    the rates, the Income-tax Act, 2025 references and where each was taken from — and have your CA
                    mark them verified — under Settings.
                  </p>
                  <Button size="sm" variant="outline" className="mt-3" asChild>
                    <Link href="/settings/tax-rates">Open TDS &amp; TCS rates</Link>
                  </Button>
                </div>
              </TabsContent>
            </Tabs>
          </>
        )}
      </AsyncPage>
    </>
  );
}
