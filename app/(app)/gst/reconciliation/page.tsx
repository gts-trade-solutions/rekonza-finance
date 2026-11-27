'use client';

// GST Reconciliation: GSTR-1 against GSTR-3B against the books, month by
// month for a financial year (lib/server/gst/gstr3b-checks.ts).
//
// The three are made from the same documents, so they agree when nothing is
// amiss. Where they do not, the law's own reasons are named — an amendment of
// an earlier return declared later, GST on an advance taxed when received, a
// header charge reported line by line — and anything else is left plainly for
// a person to look into. The month's own checks (each table against GSTR-1 and
// GSTR-2B, the ledger tie-out) are on GSTR-3B; GSTR-2B against the bills is on
// ITC Reconciliation.

import Link from 'next/link';
import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Download } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { gstReturns, type ReconciliationView } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { downloadWorkbook } from '@/lib/xlsx';
import { toRupees } from '@/lib/money';
import { periodLabel } from '@/lib/gst/filing';
import { cn } from '@/lib/utils';

const fyNow = () => {
  const d = new Date();
  return d.getMonth() < 3 ? d.getFullYear() - 1 : d.getFullYear();
};
const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const td = 'px-3 py-2 text-right tabular-nums';

function exportIt(d: ReconciliationView) {
  const rs = toRupees;
  downloadWorkbook(`GST-reconciliation-FY${d.fy}-${String((d.fy + 1) % 100).padStart(2, '0')}`, [{
    name: 'GSTR-1 vs 3B vs books',
    rows: [
      ['Month', 'GSTR-1 taxable', 'GSTR-1 tax', 'GSTR-3B taxable', 'GSTR-3B tax', 'Books taxable', 'Books tax', 'Output tax in ledger', 'GSTR-1 ARN', 'GSTR-3B ARN', 'Differences'],
      ...d.months.map((m) => [periodLabel(m.month), rs(m.gstr1.taxablePaise), rs(m.gstr1.taxPaise), rs(m.gstr3b.taxablePaise), rs(m.gstr3b.taxPaise), rs(m.books.taxablePaise), rs(m.books.taxPaise),
        rs(m.ledgerTaxPaise), m.filed.gstr1 ?? '', m.filed.gstr3b ?? '', m.differences.map((x) => `${x.between}: ${rs(x.paise)} — ${x.reason}`).join(' | ')]),
      ['Total', rs(d.totals.gstr1.taxablePaise), rs(d.totals.gstr1.taxPaise), rs(d.totals.gstr3b.taxablePaise), rs(d.totals.gstr3b.taxPaise), rs(d.totals.books.taxablePaise), rs(d.totals.books.taxPaise), rs(d.totals.ledgerTaxPaise)],
    ],
  }]);
}

export default function GstReconciliationPage() {
  const [fy, setFy] = useState(fyNow());
  const state = useApi(() => gstReturns.reconciliation(fy), [fy]);
  return (
    <>
      <PageHeader
        title="GST Reconciliation"
        description="GSTR-1 against GSTR-3B against the books, month by month, with every difference and its reason."
        actions={
          <div className="flex items-center gap-2">
            <select value={fy} onChange={(e) => setFy(Number(e.target.value))} className="h-8 rounded-[3px] border bg-background px-2 text-sm" aria-label="Financial year" data-slot="recon-fy">
              {[fyNow(), fyNow() - 1, fyNow() - 2].map((y) => <option key={y} value={y}>FY {y}-{String((y + 1) % 100).padStart(2, '0')}</option>)}
            </select>
            <Button size="sm" variant="outline" className="gap-1.5" disabled={!state.data} onClick={() => state.data && exportIt(state.data)} data-slot="recon-export"><Download className="size-3.5" /> Export</Button>
          </div>
        }
      />
      <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
        {(d) => d.months.length === 0 ? (
          <Card className="p-6 text-sm text-muted-foreground">This financial year has not started yet. Pick another year.</Card>
        ) : (
          <>
            <Card className="overflow-hidden p-0">
              <div className="overflow-x-auto thin-scroll">
                <table className="w-full min-w-[1100px] text-sm" data-slot="recon-table">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className={`${th} text-left`} rowSpan={2}>Month</th>
                      <th className={`${th} border-l text-center`} colSpan={2}>GSTR-1</th>
                      <th className={`${th} border-l text-center`} colSpan={2}>GSTR-3B</th>
                      <th className={`${th} border-l text-center`} colSpan={3}>Books</th>
                      <th className={`${th} border-l text-left`} rowSpan={2}>Agreement</th>
                    </tr>
                    <tr className="border-b bg-muted/50">
                      <th className={`${th} border-l text-right`}>Taxable</th><th className={`${th} text-right`}>Tax</th>
                      <th className={`${th} border-l text-right`}>Taxable</th><th className={`${th} text-right`}>Tax</th>
                      <th className={`${th} border-l text-right`}>Register taxable</th><th className={`${th} text-right`}>Register tax</th><th className={`${th} text-right`}>Ledger output tax</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.months.map((m) => (
                      <tr key={m.month} className="border-b align-top last:border-0" data-slot={`recon-row-${m.month}`} data-agrees={m.differences.length === 0}>
                        <td className="px-3 py-2 font-medium">
                          {periodLabel(m.month)}
                          <span className="block text-[10px] text-muted-foreground">
                            <Link href="/gst/gstr1" className="hover:underline">GSTR-1</Link>{m.filed.gstr1 ? ` filed ${m.filed.gstr1}` : ' not filed'} · <Link href="/gst/gstr3b" className="hover:underline">3B</Link>{m.filed.gstr3b ? ` filed ${m.filed.gstr3b}` : ' not filed'}
                          </span>
                        </td>
                        <td className={cn(td, 'border-l')}><Money value={m.gstr1.taxablePaise} /></td>
                        <td className={td}><Money value={m.gstr1.taxPaise} /></td>
                        <td className={cn(td, 'border-l')}><Money value={m.gstr3b.taxablePaise} /></td>
                        <td className={td}><Money value={m.gstr3b.taxPaise} /></td>
                        <td className={cn(td, 'border-l')}><Money value={m.books.taxablePaise} /></td>
                        <td className={td}><Money value={m.books.taxPaise} /></td>
                        <td className={td}><Money value={m.ledgerTaxPaise} /></td>
                        <td className="border-l px-3 py-2 text-xs">
                          {m.differences.length === 0 ? (
                            <span className="flex items-center gap-1 text-emerald-700"><CheckCircle2 className="size-3.5" /> All three agree</span>
                          ) : (
                            <ul className="space-y-1">
                              {m.differences.map((x) => (
                                <li key={x.between} className="flex gap-1.5"><AlertTriangle className="mt-0.5 size-3 shrink-0 text-amber-600" /><span><b>{x.between}</b> <Money value={x.paise} />: {x.reason}</span></li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 bg-muted/40 font-semibold" data-slot="recon-total">
                      <td className="px-3 py-2">FY total</td>
                      <td className={cn(td, 'border-l')}><Money value={d.totals.gstr1.taxablePaise} /></td>
                      <td className={td}><Money value={d.totals.gstr1.taxPaise} /></td>
                      <td className={cn(td, 'border-l')}><Money value={d.totals.gstr3b.taxablePaise} /></td>
                      <td className={td}><Money value={d.totals.gstr3b.taxPaise} /></td>
                      <td className={cn(td, 'border-l')}><Money value={d.totals.books.taxablePaise} /></td>
                      <td className={td}><Money value={d.totals.books.taxPaise} /></td>
                      <td className={td}><Money value={d.totals.ledgerTaxPaise} /></td>
                      <td className="border-l" />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Card>
            <Card className="space-y-1 p-4 text-xs text-muted-foreground">
              <p>Each month&apos;s GSTR-3B is also checked table by table against GSTR-1 and GSTR-2B, and against the ledger, on the <Link href="/gst/gstr3b" className="text-primary hover:underline">GSTR-3B</Link> screen.</p>
              <p>Input credit in the books against the suppliers&apos; filings (GSTR-2B): matched, mismatched, missing in the books and missing in 2B, with accept / defer / claim later, is on <Link href="/gst/itc-reconciliation" className="text-primary hover:underline">ITC Reconciliation</Link>.</p>
              <p>For the year as a whole, GSTR-9 and its reconciliation statement GSTR-9C: <Link href="/gst/gstr9" className="text-primary hover:underline">GSTR-9</Link>, <Link href="/gst/gstr9c" className="text-primary hover:underline">GSTR-9C</Link>.</p>
            </Card>
          </>
        )}
      </AsyncPage>
    </>
  );
}
