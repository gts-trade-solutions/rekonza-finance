'use client';

// GSTR-1 — the monthly return of everything you sold.
//
// The section split is not cosmetic. Which table a supply lands in decides
// whether the buyer can see it in their GSTR-2B and claim credit on it. Put a
// B2B sale in the B2C summary and your customer silently loses their input
// credit — and they find out at their year end, not yours.

import { useState } from 'react';
import { AlertCircle, CheckCircle2, Download } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { AsyncPage } from '@/components/shared/async-state';
import { gst, type Gstr1Response, type Gstr1Row } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { downloadJson } from '@/components/shared/report-shell';

/**
 * The portal wants sales split by who the buyer was, because each section feeds
 * a different part of the buyer's own return.
 */
const SECTION_HELP: Record<string, string> = {
  B2B: 'Sales to GST-registered businesses. They need these to claim their input credit.',
  B2CL: 'Sales above ₹1 lakh to unregistered buyers in another state (₹2.5 lakh before August 2024).',
  B2CS: 'All other sales to unregistered buyers — reported as a summary, not invoice by invoice.',
  EXP: 'Exports and supplies to SEZ units — zero-rated.',
  CDNR: 'Credit and debit notes issued against registered buyers.',
};

const thisMonth = () => new Date().toISOString().slice(0, 7);

function SupplyTable({ rows, showGstin = true }: { rows: Gstr1Row[]; showGstin?: boolean }) {
  return (
    <div className="overflow-x-auto rounded-lg border thin-scroll">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 text-left font-semibold">Document</th>
            <th className="px-3 py-2 text-left font-semibold">Date</th>
            <th className="px-3 py-2 text-left font-semibold">Customer</th>
            {showGstin && <th className="px-3 py-2 text-left font-semibold">GSTIN</th>}
            <th className="px-3 py-2 text-left font-semibold">POS</th>
            <th className="px-3 py-2 text-right font-semibold">Taxable</th>
            <th className="px-3 py-2 text-right font-semibold">CGST</th>
            <th className="px-3 py-2 text-right font-semibold">SGST</th>
            <th className="px-3 py-2 text-right font-semibold">IGST</th>
            <th className="px-3 py-2 text-right font-semibold">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={10} className="px-3 py-8 text-center text-sm text-muted-foreground">
                No entries in this section.
              </td>
            </tr>
          ) : (
            rows.map((i) => (
              <tr key={i.id} className="border-b last:border-0 hover:bg-accent/40">
                <td className="px-3 py-2 font-medium">
                  {i.number}
                  {i.againstNumber && (
                    <span className="ml-1 text-[10px] text-muted-foreground">vs {i.againstNumber}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs">{new Date(i.date).toLocaleDateString('en-IN')}</td>
                <td className="px-3 py-2">{i.customerName}</td>
                {showGstin && <td className="px-3 py-2 font-mono text-[10px]">{i.gstin ?? '—'}</td>}
                <td className="px-3 py-2 text-xs">{i.placeOfSupply}</td>
                <td className="px-3 py-2 text-right"><Money value={i.taxablePaise} /></td>
                <td className="px-3 py-2 text-right"><Money value={i.cgstPaise} showZero={false} /></td>
                <td className="px-3 py-2 text-right"><Money value={i.sgstPaise} showZero={false} /></td>
                <td className="px-3 py-2 text-right"><Money value={i.igstPaise} showZero={false} /></td>
                <td className="px-3 py-2 text-right font-medium"><Money value={i.totalPaise} /></td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function Gstr1Page() {
  const [month, setMonth] = useState(thisMonth());
  const state = useApi<Gstr1Response>(() => gst.gstr1(month), [month]);

  const [exporting, setExporting] = useState(false);
  const exportJson = async () => {
    setExporting(true);
    try {
      // Built on the server from the invoice lines: the portal wants each
      // invoice split by tax rate, which the tables on this screen do not hold.
      downloadJson(`GSTR1-${month}.json`, await gst.gstr1File(month));
      toast.success('GSTR-1 file downloaded', {
        description: 'On the GST portal: Returns → GSTR-1 → Prepare offline → Upload.',
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
        title="GSTR-1 — outward supplies"
        description="Everything you sold this month, arranged the way the GST portal wants it."
        actions={
          <>
            <Input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="h-8 w-40"
            />
            <Button size="sm" onClick={() => void exportJson()} disabled={!state.data || exporting} className="gap-1.5">
              <Download className="size-3.5" /> Export portal JSON
            </Button>
          </>
        }
      />

      <AsyncPage state={state}>
        {(d) => (
          <>
            {d.issues.length > 0 ? (
              <Card className="space-y-2 border-amber-500/40 bg-amber-500/5 p-4">
                <p className="text-sm font-medium">Before you file</p>
                {d.issues.map((e, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <AlertCircle
                      className={
                        'mt-0.5 size-3.5 shrink-0 ' +
                        (e.level === 'error' ? 'text-destructive' : 'text-amber-600 dark:text-amber-400')
                      }
                    />
                    <p className="text-xs text-muted-foreground">{e.message}</p>
                  </div>
                ))}
              </Card>
            ) : d.invoiceCount > 0 ? (
              <Card className="flex items-center gap-3 border-emerald-500/40 bg-emerald-500/5 p-4">
                <CheckCircle2 className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <p className="text-sm">Every invoice passes validation. This return is ready to upload.</p>
              </Card>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-4">
              <Card className="p-4">
                <p className="text-xs text-muted-foreground">Total taxable value</p>
                <Money value={d.totals.taxablePaise} className="mt-1 block text-xl font-semibold" />
                <p className="mt-0.5 text-xs text-muted-foreground">{d.invoiceCount} invoice(s)</p>
              </Card>
              <Card className="p-4">
                <p className="text-xs text-muted-foreground">CGST</p>
                <Money value={d.totals.cgstPaise} className="mt-1 block text-xl font-semibold" />
              </Card>
              <Card className="p-4">
                <p className="text-xs text-muted-foreground">SGST</p>
                <Money value={d.totals.sgstPaise} className="mt-1 block text-xl font-semibold" />
              </Card>
              <Card className="p-4">
                <p className="text-xs text-muted-foreground">IGST</p>
                <Money value={d.totals.igstPaise} className="mt-1 block text-xl font-semibold" />
              </Card>
            </div>

            <Tabs defaultValue="B2B">
              <TabsList>
                <TabsTrigger value="B2B">B2B ({d.b2b.length})</TabsTrigger>
                <TabsTrigger value="B2CL">B2CL ({d.b2cl.length})</TabsTrigger>
                <TabsTrigger value="B2CS">B2CS ({d.b2cs.length})</TabsTrigger>
                <TabsTrigger value="EXP">Exports ({d.exports.length})</TabsTrigger>
                <TabsTrigger value="CDNR">Credit notes ({d.creditNotes.length})</TabsTrigger>
                <TabsTrigger value="HSN">HSN ({d.hsn.length})</TabsTrigger>
              </TabsList>

              {(['B2B', 'B2CL', 'B2CS', 'EXP', 'CDNR'] as const).map((key) => (
                <TabsContent key={key} value={key} className="mt-4 space-y-3">
                  <p className="text-xs text-muted-foreground">{SECTION_HELP[key]}</p>
                  <SupplyTable
                    rows={
                      key === 'B2B' ? d.b2b
                      : key === 'B2CL' ? d.b2cl
                      : key === 'B2CS' ? d.b2cs
                      : key === 'EXP' ? d.exports
                      : d.creditNotes
                    }
                    showGstin={key === 'B2B' || key === 'CDNR'}
                  />
                </TabsContent>
              ))}

              <TabsContent value="HSN" className="mt-4 space-y-3">
                <p className="text-xs text-muted-foreground">
                  Table 12. The portal validates every code against the official master and checks the rate against
                  the one the code implies — one bad code bounces the whole return, not just its line.
                </p>
                <div className="overflow-x-auto rounded-lg border thin-scroll">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-2 text-left font-semibold">HSN/SAC</th>
                        <th className="px-3 py-2 text-left font-semibold">Description</th>
                        <th className="px-3 py-2 text-left font-semibold">UQC</th>
                        <th className="px-3 py-2 text-right font-semibold">Quantity</th>
                        <th className="px-3 py-2 text-right font-semibold">Taxable</th>
                        <th className="px-3 py-2 text-right font-semibold">Tax</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.hsn.map((h) => (
                        <tr key={h.code} className="border-b last:border-0 hover:bg-accent/40">
                          <td className="px-3 py-2 font-mono text-xs font-medium">
                            {h.code}
                            {h.code === 'UNCLASSIFIED' && (
                              <Badge variant="outline" className="ml-2 border-destructive/40 text-[9px]">
                                Missing
                              </Badge>
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">{h.description ?? '—'}</td>
                          <td className="px-3 py-2 text-xs">{h.uqc}</td>
                          <td className="px-3 py-2 text-right tabular text-xs">{h.qty}</td>
                          <td className="px-3 py-2 text-right"><Money value={h.taxablePaise} /></td>
                          <td className="px-3 py-2 text-right"><Money value={h.taxPaise} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </TabsContent>
            </Tabs>

            <Card className="p-4">
              <p className="text-sm font-medium">Document summary</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Numbers {d.documentSummary.from} to {d.documentSummary.to} — {d.documentSummary.total} issued,{' '}
                {d.documentSummary.cancelled} cancelled. The portal asks for this because a gap in the series is a
                question at assessment: every number has to be accounted for, including the ones that were voided.
              </p>
            </Card>
          </>
        )}
      </AsyncPage>
    </>
  );
}
