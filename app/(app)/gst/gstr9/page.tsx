'use client';

// GSTR-9 — the annual return, drafted from the year's documents.
//
// Every table here is computed from the invoices, notes and bills, and table 9
// is the twelve monthly GSTR-3B computations added up, so the annual return
// cannot disagree with the monthly ones. It is a draft for the person who
// files: amendments made through later returns, demands and refunds are not in
// the books and are filled in on the portal.

import { useMemo, useState } from 'react';
import { Download, Info } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { downloadCsv, ReportTable } from '@/components/shared/report-shell';
import { gst, type Gstr9Response, type HsnSummaryRow, type TaxHeadsRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';

/** The last completed financial year: annual returns are filed for it. */
const lastFy = () => {
  const d = new Date();
  return d.getFullYear() - (d.getMonth() < 3 ? 1 : 0) - 1;
};
const fyLabel = (y: number) => `${y}-${String((y + 1) % 100).padStart(2, '0')}`;

const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';

function HeadsTable({ title, rows }: { title: string; rows: { ref: string; label: string; v: TaxHeadsRow; strong?: boolean }[] }) {
  return (
    <ReportTable>
      <thead>
        <tr className="border-b bg-muted/50">
          <th className={`${th} text-left`}>{title}</th>
          <th className={`${th} text-right`}>Taxable</th>
          <th className={`${th} text-right`}>CGST</th>
          <th className={`${th} text-right`}>SGST</th>
          <th className={`${th} text-right`}>IGST</th>
          <th className={`${th} text-right`}>Cess</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.ref}-${r.label}`} className={`border-b last:border-0 ${r.strong ? 'bg-muted/30 font-semibold' : ''}`}>
            <td className="px-3 py-2 text-sm">
              <span className="mr-2 font-mono text-xs text-muted-foreground">{r.ref}</span>{r.label}
            </td>
            <td className="px-3 py-2 text-right"><Money value={r.v.taxablePaise} showZero={false} /></td>
            <td className="px-3 py-2 text-right"><Money value={r.v.cgstPaise} showZero={false} /></td>
            <td className="px-3 py-2 text-right"><Money value={r.v.sgstPaise} showZero={false} /></td>
            <td className="px-3 py-2 text-right"><Money value={r.v.igstPaise} showZero={false} /></td>
            <td className="px-3 py-2 text-right"><Money value={r.v.cessPaise} showZero={false} /></td>
          </tr>
        ))}
      </tbody>
    </ReportTable>
  );
}

function HsnTable({ title, rows }: { title: string; rows: HsnSummaryRow[] }) {
  return (
    <ReportTable>
      <thead>
        <tr className="border-b bg-muted/50">
          <th className={`${th} text-left`}>{title}</th>
          <th className={`${th} text-left`}>UQC</th>
          <th className={`${th} text-right`}>Qty</th>
          <th className={`${th} text-right`}>Rate</th>
          <th className={`${th} text-right`}>Taxable</th>
          <th className={`${th} text-right`}>Tax</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr><td colSpan={6} className="px-3 py-3 text-sm text-muted-foreground">Nothing in the year.</td></tr>
        )}
        {rows.map((r) => (
          <tr key={`${r.code}-${r.ratePct}`} className="border-b last:border-0">
            <td className="px-3 py-2 font-mono text-xs">{r.code}</td>
            <td className="px-3 py-2 text-xs">{r.uqc}</td>
            <td className="px-3 py-2 text-right text-sm tabular">{r.qty}</td>
            <td className="px-3 py-2 text-right text-sm tabular">{r.ratePct}%</td>
            <td className="px-3 py-2 text-right"><Money value={r.taxablePaise} /></td>
            <td className="px-3 py-2 text-right">
              <Money value={r.cgstPaise + r.sgstPaise + r.igstPaise + r.cessPaise} />
            </td>
          </tr>
        ))}
      </tbody>
    </ReportTable>
  );
}

export default function Gstr9Page() {
  const [fy, setFy] = useState(lastFy());
  const state = useApi<Gstr9Response>(() => gst.gstr9(fy), [fy]);
  const years = useMemo(() => Array.from({ length: 6 }, (_, i) => lastFy() + 1 - i), []);

  const exportCsv = (d: Gstr9Response) => {
    const heads = (ref: string, label: string, v: TaxHeadsRow) =>
      [ref, label, toRupees(v.taxablePaise), toRupees(v.cgstPaise), toRupees(v.sgstPaise), toRupees(v.igstPaise), toRupees(v.cessPaise)];
    downloadCsv(`GSTR9-${d.fy}.csv`, [
      ['Table', 'Particulars', 'Taxable', 'CGST', 'SGST', 'IGST', 'Cess'],
      heads('4A', 'Supplies to unregistered persons (B2C)', d.table4.b2c),
      heads('4B', 'Supplies to registered persons (B2B)', d.table4.b2b),
      heads('4C', 'Exports on payment of tax', d.table4.exportsWithTax),
      heads('4D', 'SEZ supplies on payment of tax', d.table4.sezWithTax),
      heads('4F', 'Advances on which tax was paid, not yet invoiced', d.table4.advances),
      heads('4G', 'Inward supplies on reverse charge', d.table4.rcmInward),
      heads('4I', 'Credit notes issued', d.table4.creditNotes),
      heads('4N', 'Total', d.table4.total),
      ['5A', 'Exports without payment of tax', toRupees(d.table5.exportsLut)],
      ['5B', 'SEZ supplies without payment of tax', toRupees(d.table5.sezLut)],
      ['5D/5E', 'Exempt and nil-rated', toRupees(d.table5.exemptOrNil)],
      ['5H', 'Credit notes on these', toRupees(d.table5.creditNotes)],
      ['5N', 'Total', toRupees(d.table5.total)],
      heads('6B', 'Inputs', d.table6.inputs),
      heads('6B', 'Capital goods', d.table6.capitalGoods),
      heads('6B', 'Input services', d.table6.inputServices),
      heads('6C', 'Reverse charge, unregistered suppliers', d.table6.rcmUnregistered),
      heads('6D', 'Reverse charge, registered suppliers', d.table6.rcmRegistered),
      ['7', 'Reversed by vendor credits', toRupees(d.table7.vendorCreditsPaise)],
      heads('8A', 'Credit as per GSTR-2B', d.table8.asPer2b),
      heads('8B', 'Credit as per books (6B)', d.table8.asPerBooks),
      heads('8D', 'Difference', d.table8.difference),
      ...d.table9.map((r) => ['9', r.head, toRupees(r.payablePaise), `ITC ${toRupees(r.paidThroughItcPaise)}`, `Cash ${toRupees(r.paidInCashPaise)}`]),
    ]);
  };

  return (
    <>
      <PageHeader
        title="GSTR-9 — annual return"
        description="The year restated from your documents. Table 9 is the twelve monthly GSTR-3Bs added up."
        actions={
          <>
            <Select value={String(fy)} onValueChange={(v) => setFy(Number(v))}>
              <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                {years.map((y) => <SelectItem key={y} value={String(y)}>FY {fyLabel(y)}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" className="gap-1.5" disabled={!state.data}
              onClick={() => state.data && exportCsv(state.data)}>
              <Download className="size-3.5" /> Export CSV
            </Button>
          </>
        }
      />

      <AsyncPage state={state} loading={<LoadingRows rows={12} />}>
        {(d) => (
          <>
            <Card className="flex items-start gap-3 p-4">
              <Info className="mt-0.5 size-4 shrink-0 text-primary" />
              <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
                <p className="text-sm font-medium text-foreground">
                  Draft for FY {d.fy}{d.gstin ? ` · ${d.gstin}` : ''}
                </p>
                {d.notes.map((n) => <p key={n}>{n}</p>)}
              </div>
            </Card>

            <HeadsTable title="Table 4 — supplies on which tax is payable" rows={[
              { ref: '4A', label: 'To unregistered persons (B2C)', v: d.table4.b2c },
              { ref: '4B', label: 'To registered persons (B2B)', v: d.table4.b2b },
              { ref: '4C', label: 'Exports on payment of tax', v: d.table4.exportsWithTax },
              { ref: '4D', label: 'SEZ supplies on payment of tax', v: d.table4.sezWithTax },
              { ref: '4F', label: 'Advances on which tax was paid, not yet invoiced', v: d.table4.advances },
              { ref: '4G', label: 'Inward supplies on reverse charge', v: d.table4.rcmInward },
              { ref: '4I', label: 'Credit notes issued', v: d.table4.creditNotes },
              { ref: '4N', label: 'Total', v: d.table4.total, strong: true },
            ]} />

            <ReportTable>
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className={`${th} text-left`}>Table 5 — supplies on which tax is not payable</th>
                  <th className={`${th} text-right`}>Taxable</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['5A', 'Exports without payment of tax (LUT)', d.table5.exportsLut],
                  ['5B', 'SEZ supplies without payment of tax', d.table5.sezLut],
                  ['5D/5E', 'Exempt and nil-rated', d.table5.exemptOrNil],
                  ['5H', 'Credit notes on these', d.table5.creditNotes],
                  ['5N', 'Total', d.table5.total],
                ].map(([ref, label, v]) => (
                  <tr key={ref as string} className="border-b last:border-0">
                    <td className="px-3 py-2 text-sm">
                      <span className="mr-2 font-mono text-xs text-muted-foreground">{ref}</span>{label}
                    </td>
                    <td className="px-3 py-2 text-right"><Money value={v as number} showZero={false} /></td>
                  </tr>
                ))}
              </tbody>
            </ReportTable>

            <HeadsTable title="Table 6 — input tax credit availed" rows={[
              { ref: '6B', label: 'Inputs', v: d.table6.inputs },
              { ref: '6B', label: 'Capital goods', v: d.table6.capitalGoods },
              { ref: '6B', label: 'Input services', v: d.table6.inputServices },
              { ref: '6C', label: 'Reverse charge — unregistered suppliers', v: d.table6.rcmUnregistered },
              { ref: '6D', label: 'Reverse charge — registered suppliers', v: d.table6.rcmRegistered },
              { ref: '6O', label: 'Total', v: d.table6.total, strong: true },
            ]} />

            <Card className="flex items-center justify-between p-4 text-sm">
              <span><span className="mr-2 font-mono text-xs text-muted-foreground">7</span>Credit reversed by vendor credits</span>
              <Money value={d.table7.vendorCreditsPaise} />
            </Card>

            <HeadsTable title="Table 8 — credit in GSTR-2B against the books" rows={[
              { ref: '8A', label: 'As per GSTR-2B (accepted or no IMS action)', v: d.table8.asPer2b },
              { ref: '8B', label: 'As per books (table 6B)', v: d.table8.asPerBooks },
              { ref: '8D', label: 'Difference (8A − 8B)', v: d.table8.difference, strong: true },
            ]} />

            <ReportTable>
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className={`${th} text-left`}>Table 9 — tax paid</th>
                  <th className={`${th} text-right`}>Payable</th>
                  <th className={`${th} text-right`}>Paid through ITC</th>
                  <th className={`${th} text-right`}>Paid in cash</th>
                </tr>
              </thead>
              <tbody>
                {d.table9.map((r) => (
                  <tr key={r.head} className="border-b last:border-0">
                    <td className="px-3 py-2 text-sm">{r.head === 'CESS' ? 'Cess' : r.head}</td>
                    <td className="px-3 py-2 text-right"><Money value={r.payablePaise} /></td>
                    <td className="px-3 py-2 text-right"><Money value={r.paidThroughItcPaise} /></td>
                    <td className="px-3 py-2 text-right"><Money value={r.paidInCashPaise} /></td>
                  </tr>
                ))}
              </tbody>
            </ReportTable>

            <HsnTable title="Table 17 — HSN summary of outward supplies" rows={d.table17} />
            <HsnTable title="Table 18 — HSN summary of inward supplies" rows={d.table18} />
          </>
        )}
      </AsyncPage>
    </>
  );
}
