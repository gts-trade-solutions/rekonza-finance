'use client';

// GSTR-1 — the monthly return of everything you sold, table by table.
//
// Every table of the form is here, built from the same file the portal takes
// (so what is checked is what is uploaded): B2B with reverse charge, SEZ and
// deemed exports marked (4A, 4B, 6B, 6C), B2C large (5), exports (6A), B2C
// others (7), nil-rated and exempt (8), the amendments of filed returns (9A,
// 9C, 10), credit and debit notes (9B), advances (11A, 11B), the HSN summary
// split B2B / B2C (12), documents issued (13) and the e-commerce tables (14,
// 15). Each table's totals tie to the sales register and to output tax in the
// ledger; any difference is named with its reason.
//
// The section split is not cosmetic. Which table a supply lands in decides
// whether the buyer can see it in their GSTR-2B and claim credit on it.

import Link from 'next/link';
import { useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, Download, FileJson, FileSpreadsheet, Printer, Scale } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { PageHeader } from '@/components/shared/page-header';
import { GstnReturnBar } from '@/components/gst/gstn-portal';
import { ReturnFilingBar } from '@/components/gst/return-filing';
import { Money } from '@/components/shared/money';
import { AsyncPage } from '@/components/shared/async-state';
import { gst, gstReturns, type Gstr1DocRowView, type Gstr1ReportView } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { downloadJson } from '@/components/shared/report-shell';
import { downloadWorkbook, type Cell, type Sheet } from '@/lib/xlsx';
import { toRupees } from '@/lib/money';
import { stateLabel } from '@/lib/gst/gstr3b-layout';
import { useUrlPeriod } from '@/lib/gst/url-period';

const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const short = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN');
const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const td = 'px-3 py-2 text-right tabular-nums';

type Heads = { taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; cessPaise: number };

function HeadCells({ v, bold }: { v: Heads; bold?: boolean }) {
  const c = bold ? `${td} font-semibold` : td;
  return (
    <>
      <td className={c}><Money value={v.taxablePaise} /></td>
      <td className={c}><Money value={v.igstPaise} showZero={false} /></td>
      <td className={c}><Money value={v.cgstPaise} showZero={false} /></td>
      <td className={c}><Money value={v.sgstPaise} showZero={false} /></td>
      <td className={c}><Money value={v.cessPaise} showZero={false} /></td>
    </>
  );
}
const HEAD_TH = ['Taxable value', 'IGST', 'CGST', 'SGST', 'Cess'];

function Empty({ cols, text = 'Nothing in this table for the month.' }: { cols: number; text?: string }) {
  return <tr><td colSpan={cols} className="px-3 py-6 text-center text-sm text-muted-foreground">{text}</td></tr>;
}

function TableHead({ t }: { t: { ref: string; title: string; help: string } }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <Badge variant="outline" className="font-mono text-[10px]">Table {t.ref}</Badge>
      <p className="text-sm font-semibold">{t.title}</p>
      <p className="basis-full text-xs text-muted-foreground">{t.help}</p>
    </div>
  );
}

/** One document per row: B2B, B2CL, exports, notes. */
function DocTable({ slot, rows, totals, showGstin, typeLabel }: {
  slot: string; rows: Gstr1DocRowView[]; totals: Heads & { count: number }; showGstin: boolean; typeLabel?: string;
}) {
  const cols = 6 + (showGstin ? 1 : 0) + 5;
  return (
    <div className="overflow-x-auto rounded-lg border thin-scroll">
      <table className="w-full min-w-[980px] text-sm" data-slot={`gstr1-table-${slot}`}>
        <thead>
          <tr className="border-b bg-muted/50">
            <th className={`${th} text-left`}>Document</th>
            <th className={`${th} text-left`}>Date</th>
            <th className={`${th} text-left`}>Customer</th>
            {showGstin && <th className={`${th} text-left`}>GSTIN</th>}
            <th className={`${th} text-left`}>Place of supply</th>
            <th className={`${th} text-left`}>{typeLabel ?? 'Type'}</th>
            <th className={`${th} text-right`}>Value</th>
            {HEAD_TH.map((h) => <th key={h} className={`${th} text-right`}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? <Empty cols={cols + 1} /> : rows.map((r) => (
            <tr key={`${r.docType}-${r.docId}`} className="border-b last:border-0 hover:bg-accent/40">
              <td className="px-3 py-2 font-medium">
                <Link href={r.href} className="text-primary hover:underline">{r.number}</Link>
                {r.noteType && <span className="ml-1 text-[10px] text-muted-foreground">{r.noteType === 'C' ? 'credit note' : 'debit note'}</span>}
                {r.reverseCharge && <span className="ml-1.5 rounded border px-1 text-[10px] text-muted-foreground" data-slot="gstr1-rcm">Reverse charge</span>}
                {r.eco && <span className="ml-1.5 rounded border px-1 text-[10px] text-muted-foreground" title={`Sold through ${r.eco.gstin}`}>E-commerce {r.eco.section === '9_5' ? '9(5)' : 'TCS'}</span>}
              </td>
              <td className="px-3 py-2 text-xs">{short(r.date)}</td>
              <td className="px-3 py-2">{r.party}</td>
              {showGstin && <td className="px-3 py-2 font-mono text-[11px]">{r.gstin ?? '—'}</td>}
              <td className="px-3 py-2 text-xs">{stateLabel(r.pos)}</td>
              <td className="px-3 py-2 text-xs">{r.type ?? '—'}{r.shippingBill ? <span className="block text-[10px] text-muted-foreground">SB {r.shippingBill}</span> : null}</td>
              <td className={td}><Money value={r.valuePaise} /></td>
              <HeadCells v={r} />
            </tr>
          ))}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr className="border-t-2 bg-muted/40" data-slot={`gstr1-total-${slot}`}>
              <td className="px-3 py-2 font-semibold" colSpan={cols - 5}>Total · {totals.count} document{totals.count === 1 ? '' : 's'}</td>
              <HeadCells v={totals} bold />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function SummaryTable<R extends Heads>({ slot, rows, totals, cols }: {
  slot: string; rows: R[]; totals: Heads; cols: { label: string; cell: (r: R) => React.ReactNode }[];
}) {
  return (
    <div className="overflow-x-auto rounded-lg border thin-scroll">
      <table className="w-full min-w-[760px] text-sm" data-slot={`gstr1-table-${slot}`}>
        <thead>
          <tr className="border-b bg-muted/50">
            {cols.map((c) => <th key={c.label} className={`${th} text-left`}>{c.label}</th>)}
            {HEAD_TH.map((h) => <th key={h} className={`${th} text-right`}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? <Empty cols={cols.length + 5} /> : rows.map((r, i) => (
            <tr key={i} className="border-b last:border-0">
              {cols.map((c) => <td key={c.label} className="px-3 py-2 text-xs">{c.cell(r)}</td>)}
              <HeadCells v={r} />
            </tr>
          ))}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr className="border-t-2 bg-muted/40" data-slot={`gstr1-total-${slot}`}>
              <td className="px-3 py-2 font-semibold" colSpan={cols.length}>Total</td>
              <HeadCells v={totals} bold />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function HsnTable({ slot, rows, totals, digits }: { slot: string; rows: Gstr1ReportView['tables']['hsnB2b']['rows']; totals: Heads; digits: number }) {
  return (
    <SummaryTable slot={slot} rows={rows} totals={totals} cols={[
      { label: 'HSN / SAC', cell: (r) => <span className="font-mono">{r.code || 'UNCLASSIFIED'}{r.short && <Badge variant="outline" className="ml-1.5 border-destructive/40 text-[9px] text-destructive" title={`At least ${digits} digits`}>Short</Badge>}</span> },
      { label: 'Description', cell: (r) => r.description || '—' },
      { label: 'UQC', cell: (r) => r.uqc },
      { label: 'Quantity', cell: (r) => r.qty.toLocaleString('en-IN') },
      { label: 'Rate', cell: (r) => `${r.ratePct}%` },
    ]} />
  );
}

/** The workbook: one sheet per table, as the portal's Excel offline tool lays them out. */
function exportExcel(d: Gstr1ReportView) {
  const rs = (n: number) => toRupees(n);
  const heads = (h: Heads): Cell[] => [rs(h.taxablePaise), rs(h.igstPaise), rs(h.cgstPaise), rs(h.sgstPaise), rs(h.cessPaise)];
  const docSheet = (name: string, rows: Gstr1DocRowView[]): Sheet => ({
    name, rows: [['Number', 'Date', 'Customer', 'GSTIN', 'Place of supply', 'Type', 'Reverse charge', 'E-commerce operator', 'Value', 'Taxable value', 'IGST', 'CGST', 'SGST', 'Cess'],
      ...rows.map((r) => [r.number, r.date, r.party, r.gstin ?? '', stateLabel(r.pos), r.type ?? '', r.reverseCharge ? 'Y' : 'N', r.eco?.gstin ?? '', rs(r.valuePaise), ...heads(r)])],
  });
  const t = d.tables;
  const sheets: Sheet[] = [
    { name: 'Summary', rows: [['GSTR-1', d.period.month], ['GSTIN', d.gstin ?? ''], ['Legal name', d.legalName], [],
      ['Table', 'Title', 'Documents / rows', 'Taxable value', 'IGST', 'CGST', 'SGST', 'Cess'],
      ...Object.values(t).map((x) => [x.ref, x.title, x.totals.count, ...heads(x.totals)])] },
    docSheet('b2b', t.b2b.rows), docSheet('b2cl', t.b2cl.rows), docSheet('exp', t.exp.rows),
    { name: 'b2cs', rows: [['Supply', 'Place of supply', 'Rate', 'Taxable value', 'IGST', 'CGST', 'SGST', 'Cess'], ...t.b2cs.rows.map((r) => [r.splyType, stateLabel(r.pos), r.ratePct, ...heads(r)])] },
    { name: 'exemp', rows: [['Description', 'Nil rated', 'Exempted', 'Non-GST'], ...t.nil.rows.map((r) => [r.label, rs(r.nilPaise), rs(r.exemptPaise), rs(r.nonGstPaise)])] },
    docSheet('cdnr', t.cdnr.rows), docSheet('cdnur', t.cdnur.rows),
    { name: 'at', rows: [['Place of supply', 'Supply', 'Rate', 'Advance received', 'IGST', 'CGST', 'SGST', 'Cess'], ...t.at.rows.map((r) => [stateLabel(r.pos), r.splyType, r.ratePct, ...heads(r)])] },
    { name: 'atadj', rows: [['Place of supply', 'Supply', 'Rate', 'Advance adjusted', 'IGST', 'CGST', 'SGST', 'Cess'], ...t.atadj.rows.map((r) => [stateLabel(r.pos), r.splyType, r.ratePct, ...heads(r)])] },
    { name: 'hsn(b2b)', rows: [['HSN', 'Description', 'UQC', 'Quantity', 'Rate', 'Taxable value', 'IGST', 'CGST', 'SGST', 'Cess'], ...t.hsnB2b.rows.map((r) => [r.code, r.description, r.uqc, r.qty, r.ratePct, ...heads(r)])] },
    { name: 'hsn(b2c)', rows: [['HSN', 'Description', 'UQC', 'Quantity', 'Rate', 'Taxable value', 'IGST', 'CGST', 'SGST', 'Cess'], ...t.hsnB2c.rows.map((r) => [r.code, r.description, r.uqc, r.qty, r.ratePct, ...heads(r)])] },
    { name: 'docs', rows: [['Nature of document', 'From', 'To', 'Total', 'Cancelled', 'Net issued'], ...t.docs.rows.map((r) => [r.doc, r.from, r.to, r.total, r.cancelled, r.net])] },
    { name: 'eco', rows: [['Table', 'Operator GSTIN', 'Net value', 'IGST', 'CGST', 'SGST', 'Cess'], ...t.eco14.rows.map((r) => [r.label, r.etin, ...heads(r)]), ...t.eco15.rows.map((r) => ['15 (as operator)', r.stin, ...heads(r)])] },
    { name: 'amendments', rows: [['Table', 'Kind', 'Original number', 'Original date', 'Filed for', 'Number now', 'Taxable before', 'Taxable now', 'Tax before', 'Tax now', 'In the file', 'What changed'],
      ...d.amendments.rows.map((a) => [a.table, a.kind.toUpperCase(), a.originalNumber, a.originalDate, a.originalPeriod, a.number, rs(a.before.taxablePaise), rs(a.after.taxablePaise),
        rs(a.before.igstPaise + a.before.cgstPaise + a.before.sgstPaise + a.before.cessPaise), rs(a.after.igstPaise + a.after.cgstPaise + a.after.sgstPaise + a.after.cessPaise), a.inFile ? 'Yes' : 'No', a.changes.join('; ')])] },
    { name: 'tie-out', rows: [['Against the sales register', 'Books', 'Return', 'Difference'], ...d.tieOut.register.map((l) => [l.label, rs(l.booksPaise), rs(l.returnPaise), rs(l.differencePaise)]), [],
      ['Against the ledger (output tax)', 'Ledger', 'Return', 'Difference'], ...d.tieOut.ledger.map((l) => [`${l.head} (${l.code})`, rs(l.ledgerPaise), rs(l.returnPaise), rs(l.differencePaise)])] },
  ];
  downloadWorkbook(`GSTR1_${d.gstin ?? ''}_${d.period.month}`, sheets);
}

export default function Gstr1Page() {
  const [month, setMonth] = useState(thisMonth());
  useUrlPeriod(setMonth, 'period', /^\d{4}-\d{2}$/);
  const state = useApi<Gstr1ReportView>(() => gstReturns.gstr1Report(month), [month]);
  const [busy, setBusy] = useState(false);

  const exportJson = async () => {
    setBusy(true);
    try {
      // Built on the server from the invoice lines, amendments included: the
      // portal wants each invoice split by rate, which the screen does not hold.
      downloadJson(`GSTR1-${month}.json`, await gst.gstr1File(month));
      toast.success('GSTR-1 file downloaded', { description: 'On the GST portal: Returns → GSTR-1 → Prepare Offline → Upload.' });
    } catch (e) {
      toast.error('Could not build the file', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="GSTR-1 — outward supplies"
        description="Every table of the return, as the GST portal takes it, with its totals tied to the sales register and to output tax in the ledger."
        actions={
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="h-8 w-40" aria-label="Return period" data-slot="gstr1-month" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" className="gap-1.5" disabled={!state.data || busy} data-slot="gstr1-export"><Download className="size-3.5" /> Export <ChevronDown className="size-3" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => void exportJson()} data-slot="gstr1-export-json"><FileJson className="mr-2 size-3.5" /> Portal JSON (offline upload)</DropdownMenuItem>
                <DropdownMenuItem onClick={() => state.data && exportExcel(state.data)} data-slot="gstr1-export-excel"><FileSpreadsheet className="mr-2 size-3.5" /> Excel, table by table</DropdownMenuItem>
                <DropdownMenuItem onClick={() => window.print()}><Printer className="mr-2 size-3.5" /> Print or save as PDF</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />

      <ReturnFilingBar returnType="gstr1" period={month} title="GSTR-1" onChange={() => state.refetch()} />
      <GstnReturnBar returnType="GSTR1" period={month} />

      <AsyncPage state={state}>
        {(d) => {
          const t = d.tables;

          const total = d.tieOut.register;
          return (
            <>
              {d.issues.length > 0 ? (
                <Card className="space-y-2 border-amber-500/40 bg-amber-500/5 p-4" data-slot="gstr1-issues">
                  <p className="text-sm font-medium">Before you file</p>
                  {d.issues.map((e, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <AlertCircle className={'mt-0.5 size-3.5 shrink-0 ' + (e.level === 'error' ? 'text-destructive' : 'text-amber-600')} />
                      <p className="text-xs text-muted-foreground">{e.message}</p>
                    </div>
                  ))}
                </Card>
              ) : d.documentCount > 0 ? (
                <Card className="flex items-center gap-3 border-emerald-500/40 bg-emerald-500/5 p-4">
                  <CheckCircle2 className="size-5 shrink-0 text-emerald-600" />
                  <p className="text-sm">Every document passes the portal&apos;s checks. This return is ready to upload.</p>
                </Card>
              ) : (
                <Card className="p-4 text-sm text-muted-foreground" data-slot="gstr1-empty">
                  No sales documents are dated in this month yet. Raise invoices, credit or debit notes in Sales (or pick another month above); each one lands in its table here as it is saved.
                </Card>
              )}

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" data-slot="gstr1-tiles">
                <Card className="p-4"><p className="micro-label">Taxable value</p><Money value={total[0].returnPaise} className="mt-1 block text-xl font-semibold" /><p className="mt-0.5 text-xs text-muted-foreground">{d.documentCount} document(s)</p></Card>
                <Card className="p-4"><p className="micro-label">IGST</p><Money value={total[1].returnPaise} className="mt-1 block text-xl font-semibold" /></Card>
                <Card className="p-4"><p className="micro-label">CGST</p><Money value={total[2].returnPaise} className="mt-1 block text-xl font-semibold" /></Card>
                <Card className="p-4"><p className="micro-label">SGST</p><Money value={total[3].returnPaise} className="mt-1 block text-xl font-semibold" /></Card>
                <Card className={'p-4 ' + (d.tieOut.tied ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-amber-500/40 bg-amber-500/5')} data-slot="gstr1-tied" data-tied={d.tieOut.tied}>
                  <p className="micro-label">Tie-out with the books</p>
                  <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold">{d.tieOut.tied ? <><CheckCircle2 className="size-4 text-emerald-600" /> Agrees to the paisa</> : <><Scale className="size-4 text-amber-600" /> Differences below</>}</p>
                </Card>
              </div>

              {d.amendments.count > 0 && (
                <Card className="space-y-2 p-4" data-slot="gstr1-amendments">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Badge variant="outline" className="font-mono text-[10px]">Tables 9A, 9C, 10</Badge>
                    <p className="text-sm font-semibold">Amendments of returns already filed ({d.amendments.count})</p>
                    <p className="basis-full text-xs text-muted-foreground">These documents were reported in a filed GSTR-1 and have changed since. They go in this month&apos;s file with their original number and date (section 37(3)); GSTR-3B declares the difference this month.</p>
                  </div>
                  <div className="overflow-x-auto rounded-md border thin-scroll">
                    <table className="w-full min-w-[900px] text-sm">
                      <thead><tr className="border-b bg-muted/50">
                        {['Table', 'Original', 'Filed for', 'Now', 'Taxable filed', 'Taxable now', 'Tax filed', 'Tax now', 'What changed'].map((h) => <th key={h} className={`${th} text-left`}>{h}</th>)}
                      </tr></thead>
                      <tbody>
                        {d.amendments.rows.map((a) => (
                          <tr key={`${a.docType}-${a.docId}`} className="border-b last:border-0" data-slot="gstr1-amendment-row">
                            <td className="px-3 py-2 text-xs">{a.table} · {a.kind.toUpperCase()}</td>
                            <td className="px-3 py-2 text-xs">{a.originalNumber} <span className="text-muted-foreground">{short(a.originalDate)}</span></td>
                            <td className="px-3 py-2 text-xs">{a.originalPeriod}</td>
                            <td className="px-3 py-2 text-xs">{a.number}</td>
                            <td className={td}><Money value={a.before.taxablePaise} /></td>
                            <td className={td}><Money value={a.after.taxablePaise} /></td>
                            <td className={td}><Money value={a.before.igstPaise + a.before.cgstPaise + a.before.sgstPaise + a.before.cessPaise} /></td>
                            <td className={td}><Money value={a.after.igstPaise + a.after.cgstPaise + a.after.sgstPaise + a.after.cessPaise} /></td>
                            <td className="px-3 py-2 text-xs">{a.changes.join('; ')}{!a.inFile && <span className="block text-amber-700">{a.cancelled ? 'Not in the file: issue a credit note instead.' : a.movedTo ? 'Not in the file: the portal amends within a table only.' : 'In table 10 as the revised month.'}</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}

              <Tabs defaultValue="b2b">
                <TabsList className="flex h-auto flex-wrap justify-start">
                  {([
                    ['b2b', `4 B2B (${t.b2b.totals.count})`], ['b2cl', `5 B2CL (${t.b2cl.totals.count})`], ['exp', `6A Exports (${t.exp.totals.count})`],
                    ['b2cs', `7 B2CS (${t.b2cs.rows.length})`], ['nil', `8 Nil / exempt (${t.nil.rows.length})`], ['cdnr', `9B CDNR (${t.cdnr.totals.count})`],
                    ['cdnur', `9B CDNUR (${t.cdnur.totals.count})`], ['adv', `11 Advances (${t.at.rows.length + t.atadj.rows.length})`],
                    ['hsn', `12 HSN (${t.hsnB2b.rows.length + t.hsnB2c.rows.length})`], ['docs', `13 Documents (${t.docs.rows.length})`],
                    ['eco', `14–15 E-commerce (${t.eco14.rows.length + t.eco15.rows.length})`],
                  ] as const).map(([k, label]) => <TabsTrigger key={k} value={k} data-slot={`gstr1-tab-${k}`}>{label}</TabsTrigger>)}
                </TabsList>

                <TabsContent value="b2b" className="mt-4 space-y-3"><TableHead t={t.b2b} /><DocTable slot="b2b" rows={t.b2b.rows} totals={t.b2b.totals} showGstin typeLabel="Invoice type" /></TabsContent>
                <TabsContent value="b2cl" className="mt-4 space-y-3"><TableHead t={t.b2cl} /><DocTable slot="b2cl" rows={t.b2cl.rows} totals={t.b2cl.totals} showGstin={false} /></TabsContent>
                <TabsContent value="exp" className="mt-4 space-y-3"><TableHead t={t.exp} /><DocTable slot="exp" rows={t.exp.rows} totals={t.exp.totals} showGstin={false} typeLabel="With / without payment" /></TabsContent>
                <TabsContent value="b2cs" className="mt-4 space-y-3">
                  <TableHead t={t.b2cs} />
                  <SummaryTable slot="b2cs" rows={t.b2cs.rows} totals={t.b2cs.totals} cols={[
                    { label: 'Supply', cell: (r) => (r.splyType === 'INTRA' ? 'Intra-state' : 'Inter-state') },
                    { label: 'Place of supply', cell: (r) => stateLabel(r.pos) },
                    { label: 'Rate', cell: (r) => `${r.ratePct}%` },
                  ]} />
                  <details className="rounded-md border p-2 text-xs">
                    <summary className="cursor-pointer text-muted-foreground">The {t.b2cs.documents.length} document(s) behind the summary</summary>
                    <div className="mt-2"><DocTable slot="b2cs-docs" rows={t.b2cs.documents} totals={{ ...t.b2cs.totals, count: t.b2cs.documents.length }} showGstin={false} /></div>
                  </details>
                </TabsContent>
                <TabsContent value="nil" className="mt-4 space-y-3">
                  <TableHead t={t.nil} />
                  <div className="overflow-x-auto rounded-lg border"><table className="w-full text-sm" data-slot="gstr1-table-nil">
                    <thead><tr className="border-b bg-muted/50"><th className={`${th} text-left`}>Description</th><th className={`${th} text-right`}>Nil rated</th><th className={`${th} text-right`}>Exempted</th><th className={`${th} text-right`}>Non-GST</th></tr></thead>
                    <tbody>{t.nil.rows.length === 0 ? <Empty cols={4} /> : t.nil.rows.map((r) => (
                      <tr key={r.splyType} className="border-b last:border-0"><td className="px-3 py-2 text-xs">{r.label}</td><td className={td}><Money value={r.nilPaise} /></td><td className={td}><Money value={r.exemptPaise} /></td><td className={td}><Money value={r.nonGstPaise} /></td></tr>
                    ))}</tbody>
                  </table></div>
                </TabsContent>
                <TabsContent value="cdnr" className="mt-4 space-y-3"><TableHead t={t.cdnr} /><DocTable slot="cdnr" rows={t.cdnr.rows} totals={t.cdnr.totals} showGstin /></TabsContent>
                <TabsContent value="cdnur" className="mt-4 space-y-3"><TableHead t={t.cdnur} /><DocTable slot="cdnur" rows={t.cdnur.rows} totals={t.cdnur.totals} showGstin={false} typeLabel="Against" /></TabsContent>
                <TabsContent value="adv" className="mt-4 space-y-4">
                  {([t.at, t.atadj] as const).map((x) => (
                    <div key={x.key} className="space-y-2">
                      <TableHead t={x} />
                      <SummaryTable slot={x.key} rows={x.rows} totals={x.totals} cols={[
                        { label: 'Place of supply', cell: (r) => stateLabel(r.pos) },
                        { label: 'Supply', cell: (r) => (r.splyType === 'INTRA' ? 'Intra-state' : 'Inter-state') },
                        { label: 'Rate', cell: (r) => `${r.ratePct}%` },
                      ]} />
                    </div>
                  ))}
                </TabsContent>
                <TabsContent value="hsn" className="mt-4 space-y-4">
                  <TableHead t={t.hsnB2b} /><HsnTable slot="hsn-b2b" rows={t.hsnB2b.rows} totals={t.hsnB2b.totals} digits={d.hsnDigits} />
                  <TableHead t={t.hsnB2c} /><HsnTable slot="hsn-b2c" rows={t.hsnB2c.rows} totals={t.hsnB2c.totals} digits={d.hsnDigits} />
                </TabsContent>
                <TabsContent value="docs" className="mt-4 space-y-3">
                  <TableHead t={t.docs} />
                  <div className="overflow-x-auto rounded-lg border"><table className="w-full text-sm" data-slot="gstr1-table-docs">
                    <thead><tr className="border-b bg-muted/50">{['Nature of document', 'From', 'To', 'Total', 'Cancelled', 'Net issued'].map((h) => <th key={h} className={`${th} text-left`}>{h}</th>)}</tr></thead>
                    <tbody>{t.docs.rows.length === 0 ? <Empty cols={6} /> : t.docs.rows.map((r, i) => (
                      <tr key={i} className="border-b last:border-0"><td className="px-3 py-2 text-xs">{r.doc}</td><td className="px-3 py-2 font-mono text-xs">{r.from}</td><td className="px-3 py-2 font-mono text-xs">{r.to}</td><td className="px-3 py-2">{r.total}</td><td className="px-3 py-2">{r.cancelled}</td><td className="px-3 py-2 font-medium">{r.net}</td></tr>
                    ))}</tbody>
                  </table></div>
                </TabsContent>
                <TabsContent value="eco" className="mt-4 space-y-4">
                  <TableHead t={t.eco14} />
                  <SummaryTable slot="eco14" rows={t.eco14.rows} totals={t.eco14.totals} cols={[{ label: 'Operator GSTIN', cell: (r) => <span className="font-mono">{r.etin}</span> }, { label: 'Part', cell: (r) => r.label }]} />
                  <TableHead t={t.eco15} />
                  <SummaryTable slot="eco15" rows={t.eco15.rows} totals={t.eco15.totals} cols={[{ label: 'Supplier GSTIN', cell: (r) => <span className="font-mono">{r.stin}</span> }, { label: 'Place of supply', cell: (r) => stateLabel(r.pos) }, { label: 'Rate', cell: (r) => `${r.ratePct}%` }]} />
                </TabsContent>
              </Tabs>

              <Card className="space-y-3 p-4" data-slot="gstr1-tieout">
                <div className="flex flex-wrap items-baseline gap-2">
                  <p className="text-sm font-semibold">Tie-out with the books</p>
                  <p className="text-xs text-muted-foreground">Every table above, added up, against the sales register and against output tax posted in the general ledger for the month.</p>
                </div>
                <div className="grid gap-4 lg:grid-cols-2">
                  <table className="w-full text-sm" data-slot="gstr1-tieout-register">
                    <thead><tr className="border-b bg-muted/50"><th className={`${th} text-left`}>Sales register</th><th className={`${th} text-right`}>Books</th><th className={`${th} text-right`}>Return</th><th className={`${th} text-right`}>Difference</th></tr></thead>
                    <tbody>{d.tieOut.register.map((l) => (
                      <tr key={l.label} className="border-b last:border-0"><td className="px-3 py-1.5">{l.label}</td><td className={td}><Money value={l.booksPaise} /></td><td className={td}><Money value={l.returnPaise} /></td><td className={`${td} ${l.differencePaise ? 'text-amber-700' : 'text-emerald-700'}`}><Money value={l.differencePaise} /></td></tr>
                    ))}</tbody>
                  </table>
                  <table className="w-full text-sm" data-slot="gstr1-tieout-ledger">
                    <thead><tr className="border-b bg-muted/50"><th className={`${th} text-left`}>Output tax ledger</th><th className={`${th} text-right`}>Ledger</th><th className={`${th} text-right`}>Return</th><th className={`${th} text-right`}>Difference</th></tr></thead>
                    <tbody>{d.tieOut.ledger.map((l) => (
                      <tr key={l.head} className="border-b last:border-0"><td className="px-3 py-1.5">{l.head} <span className="text-[10px] text-muted-foreground">({l.code})</span></td><td className={td}><Money value={l.ledgerPaise} /></td><td className={td}><Money value={l.returnPaise} /></td><td className={`${td} ${l.differencePaise ? 'text-amber-700' : 'text-emerald-700'}`}><Money value={l.differencePaise} /></td></tr>
                    ))}</tbody>
                  </table>
                </div>
                {d.tieOut.registerReasons.length > 0 && (
                  <ul className="space-y-1 text-xs text-muted-foreground" data-slot="gstr1-tieout-reasons">
                    {d.tieOut.registerReasons.map((r) => <li key={r.number}><Link href={r.href} className="text-primary hover:underline">{r.number}</Link>: {r.reason} (<Money value={r.paise} />)</li>)}
                  </ul>
                )}
                {d.tieOut.ledgerBySource.length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground">Output tax posted in the month, by source</summary>
                    <table className="mt-2 w-full text-xs"><tbody>{d.tieOut.ledgerBySource.map((s) => (
                      <tr key={s.source} className="border-b last:border-0"><td className="py-1 pr-3">{s.label}{!s.inReturn && <span className="ml-1 text-amber-700">· not in the return</span>}</td><td className="py-1 text-right"><Money value={s.igstPaise + s.cgstPaise + s.sgstPaise + s.cessPaise} /></td></tr>
                    ))}</tbody></table>
                  </details>
                )}
                <p className="text-xs text-muted-foreground">
                  The month against GSTR-3B and the books, and the year: <Link href="/gst/reconciliation" className="text-primary hover:underline">GST Reconciliation</Link>.
                </p>
              </Card>
            </>
          );
        }}
      </AsyncPage>
    </>
  );
}
