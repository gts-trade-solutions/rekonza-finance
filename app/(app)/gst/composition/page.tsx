'use client';

// The composition dealer's returns. CMP-08 each quarter: tax on turnover at
// the category's flat rate, plus reverse charge, booked as the dealer's own
// cost. GSTR-4 for the year: inward supplies, the quarters' CMP-08s, and
// outward supplies at the composition rate. See lib/server/gst/composition.ts.

import Link from 'next/link';
import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { ReportTable } from '@/components/shared/report-shell';
import { useSession } from '@/components/layout/session-provider';
import { usePermission } from '@/lib/store/hooks';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { downloadWorkbook } from '@/lib/xlsx';

interface Cmp08 {
  fy: number; quarter: 1 | 2 | 3 | 4; from: string; to: string; category: string | null; ratePct: number;
  turnoverPaise: number; exemptPaise: number; outward: { cgst: number; sgst: number };
  reverseCharge: { cgst: number; sgst: number; igst: number; cess: number }; totalPaise: number; dueDate: string;
  booked: { journalEntryId: string | null; at: string } | null; issues: string[];
}
interface InwardRow { gstin: string | null; name: string; bills: number; taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; cessPaise: number }
interface Gstr4 {
  fy: number; dueDate: string;
  inward: { registered: InwardRow[]; registeredRcm: InwardRow[]; unregistered: InwardRow; importOfServices: InwardRow };
  quarters: Cmp08[];
  outward: { ratePct: number; turnoverPaise: number; cgstPaise: number; sgstPaise: number };
}

const currentFy = () => {
  const d = new Date();
  return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
};
const fyLabel = (y: number) => `FY ${y}-${String((y + 1) % 100).padStart(2, '0')}`;
const day = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const QLABEL = { 1: 'April–June', 2: 'July–September', 3: 'October–December', 4: 'January–March' } as const;
const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const rupees = (p: number) => p / 100;

export default function CompositionPage() {
  const session = useSession();
  const [fy, setFy] = useState(currentFy());
  const years = Array.from({ length: 5 }, (_, i) => currentFy() - i);
  const composition = session.org?.gstRegistrationType === 'composition';

  return (
    <div className="space-y-5">
      <PageHeader
        title="Composition returns"
        description="CMP-08 each quarter and GSTR-4 for the year, for a business in the composition scheme."
        actions={(
          <Select value={String(fy)} onValueChange={(v) => setFy(Number(v))}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>{years.map((y) => <SelectItem key={y} value={String(y)}>{fyLabel(y)}</SelectItem>)}</SelectContent>
          </Select>
        )}
      />
      {!composition && (
        <Card className="flex items-start gap-3 border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <p>
            This book is not in the composition scheme now. Figures appear here only for dates it was, as recorded in{' '}
            <Link href="/settings?tab=statutory" className="text-primary hover:underline">Settings → Statutory</Link>.
          </p>
        </Card>
      )}
      <Tabs defaultValue="cmp08">
        <TabsList>
          <TabsTrigger value="cmp08">CMP-08 (quarterly)</TabsTrigger>
          <TabsTrigger value="gstr4">GSTR-4 (annual)</TabsTrigger>
        </TabsList>
        <TabsContent value="cmp08" className="mt-4"><Quarters fy={fy} composition={composition} /></TabsContent>
        <TabsContent value="gstr4" className="mt-4"><Annual fy={fy} /></TabsContent>
      </Tabs>
    </div>
  );
}

function Quarters({ fy, composition }: { fy: number; composition: boolean }) {
  const canEdit = usePermission('gst', 'edit');
  const state = useApi<Cmp08[]>(() => api.get('/api/composition', { view: 'cmp08', fy }), [fy]);
  const [busy, setBusy] = useState<number | null>(null);
  const book = async (q: Cmp08) => {
    setBusy(q.quarter);
    try {
      await api.post('/api/composition', { action: 'book', fy, quarter: q.quarter });
      toast.success(`Composition tax for ${QLABEL[q.quarter]} booked`, { description: 'Dr Composition Tax, Cr Output CGST and SGST payable.' });
      void state.refetch();
    } catch (e) {
      toast.error('Not booked', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <AsyncPage state={state} loading={<LoadingRows rows={6} />}>
      {(qs) => (
        <div className="space-y-4">
          {composition && qs[0]?.issues.filter((i) => i.includes('category')).map((i) => (
            <Card key={i} className="flex items-start gap-3 border-amber-500/40 bg-amber-500/5 p-4 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
              <p>{i} <Link href="/settings?tab=statutory" className="text-primary hover:underline">Set it</Link></p>
            </Card>
          ))}
          <div className="grid gap-4 lg:grid-cols-2">
            {qs.map((q) => (
              <Card key={q.quarter} className="space-y-3 p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold">{QLABEL[q.quarter]} {q.quarter === 4 ? fy + 1 : fy}</h3>
                  <span className="text-xs text-muted-foreground">due {day(q.dueDate)}</span>
                  {q.booked
                    ? <Badge variant="outline" className="ml-auto gap-1 border-emerald-500/40 text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="size-3" /> Booked</Badge>
                    : null}
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                  <dt className="text-muted-foreground">Turnover</dt><dd className="text-right"><Money value={q.turnoverPaise} /></dd>
                  {q.exemptPaise !== 0 && (<><dt className="text-muted-foreground">Exempt sales left out</dt><dd className="text-right"><Money value={q.exemptPaise} /></dd></>)}
                  <dt className="text-muted-foreground">Central tax at {q.ratePct / 2}%</dt><dd className="text-right"><Money value={q.outward.cgst} /></dd>
                  <dt className="text-muted-foreground">State tax at {q.ratePct / 2}%</dt><dd className="text-right"><Money value={q.outward.sgst} /></dd>
                  {(q.reverseCharge.cgst + q.reverseCharge.sgst + q.reverseCharge.igst + q.reverseCharge.cess) > 0 && (
                    <>
                      <dt className="text-muted-foreground">Reverse charge</dt>
                      <dd className="text-right"><Money value={q.reverseCharge.cgst + q.reverseCharge.sgst + q.reverseCharge.igst + q.reverseCharge.cess} /></dd>
                    </>
                  )}
                  <dt className="border-t pt-1.5 font-medium">Payable with CMP-08</dt>
                  <dd className="border-t pt-1.5 text-right font-semibold"><Money value={q.totalPaise} /></dd>
                </dl>
                {canEdit && !q.booked && q.category && (
                  <Button size="sm" variant="outline" disabled={busy !== null} className="gap-1.5" onClick={() => void book(q)}>
                    {busy === q.quarter && <Loader2 className="size-3.5 animate-spin" />} Book the tax on turnover
                  </Button>
                )}
              </Card>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            The tax on turnover cannot be collected from buyers, so it is booked as Composition Tax, an expense, against
            output CGST and SGST payable. Reverse charge was booked with each bill and is paid with the same CMP-08.
          </p>
        </div>
      )}
    </AsyncPage>
  );
}

function Annual({ fy }: { fy: number }) {
  const state = useApi<Gstr4>(() => api.get('/api/composition', { view: 'gstr4', fy }), [fy]);
  const inwardRows = (title: string, rows: InwardRow[]) => (
    <Card className="overflow-hidden p-0">
      <div className="border-b px-4 py-2.5 text-sm font-semibold">{title}</div>
      {rows.length === 0 ? <p className="p-4 text-sm text-muted-foreground">None.</p> : (
        <ReportTable>
          <thead><tr className="border-b">
            <th className={`${th} text-left`}>Supplier</th><th className={`${th} text-right`}>Bills</th>
            <th className={`${th} text-right`}>Taxable</th><th className={`${th} text-right`}>IGST</th>
            <th className={`${th} text-right`}>CGST</th><th className={`${th} text-right`}>SGST</th><th className={`${th} text-right`}>Cess</th>
          </tr></thead>
          <tbody className="divide-y">
            {rows.map((r) => (
              <tr key={`${r.gstin}-${r.name}`}>
                <td className="px-3 py-2"><p>{r.name}</p>{r.gstin && <p className="font-mono text-[11px] text-muted-foreground">{r.gstin}</p>}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.bills}</td>
                <td className="px-3 py-2 text-right"><Money value={r.taxablePaise} /></td>
                <td className="px-3 py-2 text-right"><Money value={r.igstPaise} /></td>
                <td className="px-3 py-2 text-right"><Money value={r.cgstPaise} /></td>
                <td className="px-3 py-2 text-right"><Money value={r.sgstPaise} /></td>
                <td className="px-3 py-2 text-right"><Money value={r.cessPaise} /></td>
              </tr>
            ))}
          </tbody>
        </ReportTable>
      )}
    </Card>
  );
  const download = (g: Gstr4) => {
    const inward = (rows: InwardRow[]) => rows.map((r) => [r.gstin ?? '', r.name, r.bills, rupees(r.taxablePaise), rupees(r.igstPaise), rupees(r.cgstPaise), rupees(r.sgstPaise), rupees(r.cessPaise)]);
    const head = ['GSTIN', 'Supplier', 'Bills', 'Taxable value', 'IGST', 'CGST', 'SGST', 'Cess'];
    downloadWorkbook(`gstr4-${g.fy}.xlsx`, [
      { name: '4A Registered', rows: [head, ...inward(g.inward.registered)] },
      { name: '4B Registered RCM', rows: [head, ...inward(g.inward.registeredRcm)] },
      { name: '4C 4D Unregistered, import', rows: [head, ...inward([g.inward.unregistered, g.inward.importOfServices])] },
      { name: '5 CMP-08', rows: [['Quarter', 'Turnover', 'Central tax', 'State tax', 'Reverse charge', 'Total'],
        ...g.quarters.map((q) => [QLABEL[q.quarter], rupees(q.turnoverPaise), rupees(q.outward.cgst), rupees(q.outward.sgst),
          rupees(q.reverseCharge.cgst + q.reverseCharge.sgst + q.reverseCharge.igst + q.reverseCharge.cess), rupees(q.totalPaise)])] },
      { name: '6 Outward', rows: [['Rate %', 'Turnover', 'Central tax', 'State tax'],
        [g.outward.ratePct, rupees(g.outward.turnoverPaise), rupees(g.outward.cgstPaise), rupees(g.outward.sgstPaise)]] },
    ]);
  };
  return (
    <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
      {(g) => (
        <div className="space-y-4">
          <Card className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4 text-sm">
            <span>Due <span className="font-medium">{day(g.dueDate)}</span></span>
            <span>Outward at {g.outward.ratePct}%: <Money value={g.outward.turnoverPaise} className="font-medium" /></span>
            <span>Tax on turnover: <Money value={g.outward.cgstPaise + g.outward.sgstPaise} className="font-medium" /></span>
            <Button size="sm" variant="outline" className="ml-auto gap-1.5" onClick={() => download(g)}><Download className="size-3.5" /> Excel</Button>
          </Card>
          {inwardRows('4A · Inward supplies from registered suppliers', g.inward.registered)}
          {inwardRows('4B · From registered suppliers, under reverse charge', g.inward.registeredRcm)}
          {inwardRows('4C and 4D · From unregistered suppliers, and import of services',
            [g.inward.unregistered, g.inward.importOfServices].filter((r) => r.bills > 0))}
          <p className="text-xs text-muted-foreground">
            Table 4A is checked on the portal against what suppliers filed (GSTR-4A); TDS and TCS credit (table 8) is taken from the portal too.
          </p>
        </div>
      )}
    </AsyncPage>
  );
}
