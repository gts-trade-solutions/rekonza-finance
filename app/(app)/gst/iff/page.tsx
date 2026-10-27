'use client';

// IFF — the Invoice Furnishing Facility, for quarterly (QRMP) filers.
//
// A business that files GSTR-1 quarterly may upload its B2B invoices and notes
// in the first two months of the quarter, so that its buyers see them in their
// GSTR-2B and can claim the credit without waiting three months. It is the B2B
// part of GSTR-1 and nothing else, taken from the same computation.

import { useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Download, Info } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { downloadCsv, downloadJson, ReportTable } from '@/components/shared/report-shell';
import { gst, type Gstr1Row, type IffResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';

const thisMonth = () => new Date().toISOString().slice(0, 7);
const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';

function Docs({ title, rows }: { title: string; rows: Gstr1Row[] }) {
  return (
    <ReportTable>
      <thead>
        <tr className="border-b bg-muted/50">
          <th className={`${th} text-left`}>{title}</th>
          <th className={`${th} text-left`}>Buyer GSTIN</th>
          <th className={`${th} text-left`}>Date</th>
          <th className={`${th} text-right`}>Taxable</th>
          <th className={`${th} text-right`}>Tax</th>
          <th className={`${th} text-right`}>Value</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr><td colSpan={6} className="px-3 py-3 text-sm text-muted-foreground">None this month.</td></tr>
        )}
        {rows.map((r) => (
          <tr key={r.id} className="border-b last:border-0">
            <td className="px-3 py-2 text-sm">
              <span className="font-mono text-xs">{r.number}</span>
              <span className="block text-xs text-muted-foreground">{r.customerName}</span>
            </td>
            <td className="px-3 py-2 font-mono text-[10px]">{r.gstin}</td>
            <td className="px-3 py-2 text-xs">{new Date(`${r.date}T00:00:00`).toLocaleDateString('en-IN')}</td>
            <td className="px-3 py-2 text-right"><Money value={r.taxablePaise} /></td>
            <td className="px-3 py-2 text-right">
              <Money value={r.cgstPaise + r.sgstPaise + r.igstPaise + r.cessPaise} />
            </td>
            <td className="px-3 py-2 text-right"><Money value={r.totalPaise} /></td>
          </tr>
        ))}
      </tbody>
    </ReportTable>
  );
}

export default function IffPage() {
  const [month, setMonth] = useState(thisMonth());
  const state = useApi<IffResponse>(() => gst.iff(month), [month]);

  const exportCsv = (d: IffResponse) => {
    const row = (kind: string, r: Gstr1Row) => [
      kind, r.gstin ?? '', r.customerName, r.number, r.date, r.placeOfSupply,
      toRupees(r.taxablePaise), toRupees(r.cgstPaise), toRupees(r.sgstPaise), toRupees(r.igstPaise),
      toRupees(r.cessPaise), toRupees(r.totalPaise),
    ];
    downloadCsv(`IFF-${month}.csv`, [
      ['Table', 'Buyer GSTIN', 'Buyer', 'Number', 'Date', 'Place of supply', 'Taxable', 'CGST', 'SGST', 'IGST', 'Cess', 'Value'],
      ...d.b2b.map((r) => row('B2B invoice', r)),
      ...d.cdnr.map((r) => row('Credit note', r)),
    ]);
  };

  const [exporting, setExporting] = useState(false);
  const exportJson = async () => {
    setExporting(true);
    try {
      downloadJson(`IFF-${month}.json`, await gst.gstr1File(month, 'iff'));
      toast.success('IFF file downloaded', {
        description: 'On the GST portal: Returns → IFF → Prepare offline → Upload.',
      });
    } catch (e) {
      toast.error('Could not build the file', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <PageHeader
        title="IFF — B2B invoices for quarterly filers"
        description="Upload these in the first two months of a quarter so your buyers can claim credit without waiting for your quarterly GSTR-1."
        actions={
          <>
            <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="h-8 w-40" />
            <Button size="sm" variant="outline" className="gap-1.5" disabled={!state.data}
              onClick={() => state.data && exportCsv(state.data)}>
              <Download className="size-3.5" /> Export CSV
            </Button>
            <Button size="sm" className="gap-1.5" disabled={!state.data || exporting} onClick={() => void exportJson()}>
              <Download className="size-3.5" /> Export portal JSON
            </Button>
          </>
        }
      />

      <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
        {(d) => (
          <>
            {d.issues.map((i) => (
              <Card key={i.message} className={`flex items-start gap-2 p-3 ${i.level === 'error' ? 'border-destructive/40 bg-destructive/5' : 'border-amber-500/40 bg-amber-500/5'}`}>
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <p className="text-sm">{i.message}</p>
              </Card>
            ))}

            <div className="grid gap-3 sm:grid-cols-2">
              <Card className="p-4">
                <p className="text-xs text-muted-foreground">B2B invoices</p>
                <Money value={d.totals.b2b.taxablePaise} className="mt-1 block text-2xl font-semibold" />
                <p className="mt-0.5 text-xs text-muted-foreground">{d.b2b.length} invoice(s), taxable value</p>
              </Card>
              <Card className="p-4">
                <p className="text-xs text-muted-foreground">Credit notes to registered buyers</p>
                <Money value={d.totals.cdnr.taxablePaise} className="mt-1 block text-2xl font-semibold" />
                <p className="mt-0.5 text-xs text-muted-foreground">{d.cdnr.length} note(s), taxable value</p>
              </Card>
            </div>

            <Docs title="B2B invoices" rows={d.b2b} />
            <Docs title="Credit notes" rows={d.cdnr} />

            <Card className="flex items-start gap-3 p-4">
              <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p className="text-xs leading-relaxed text-muted-foreground">
                IFF is optional and only for businesses on the quarterly return scheme. Whatever is uploaded here is
                not repeated in the quarter&apos;s GSTR-1, so upload each invoice once. A monthly filer reports all of
                this in GSTR-1 instead.
              </p>
            </Card>
          </>
        )}
      </AsyncPage>
    </>
  );
}
