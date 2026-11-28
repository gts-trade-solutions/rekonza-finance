'use client';

// GSTR-9 — the annual return (CGST Act s.44, Rule 80), table by table as the
// form lays it out, worked out from the year's documents.
//
// Tables 4 and 5 are the year's sales and notes, 6 to 8 the credit taken,
// reversed and matched against GSTR-2B, 9 the twelve GSTR-3B returns added
// up, 10 to 14 what of this year went through the next year's returns up to
// 30 November, 16 to 18 composition purchases, deemed supplies and the HSN
// summaries, 19 the late fee. Every figure says where it came from; the few
// rows no document can supply (TRAN credit, demands and refunds, the late fee
// paid) are entered here and can be edited or deleted. The file downloads in
// the GSTN offline tool's own format.

import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, Download, FileJson, FileSpreadsheet, Info, Pencil, Printer, Scale, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { downloadJson } from '@/components/shared/report-shell';
import { useConfirmDelete } from '@/components/shared/row-actions';
import { ReturnFilingBar } from '@/components/gst/return-filing';
import {
  ApiError, gstr9Annual, type Gstr9Annual, type Gstr9AnnualHeads, type Gstr9AnnualHsnRow, type Gstr9AnnualInputs,
} from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { toRupees } from '@/lib/money';
import { downloadWorkbook, type Cell, type Sheet } from '@/lib/xlsx';
import { cn } from '@/lib/utils';
import { useUrlPeriod } from '@/lib/gst/url-period';


/** The financial year now running, by the year it starts in. */
const currentFy = () => {
  const d = new Date();
  return d.getMonth() < 3 ? d.getFullYear() - 1 : d.getFullYear();
};
const fyLabel = (y: number) => `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
const longDay = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const td = 'px-3 py-1.5 text-right tabular';
type H = Gstr9AnnualHeads;
const ZERO: H = { taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, cessPaise: 0 };

/** A part of the form: its title, where it comes from, and its rows. */
function Part({ id, title, hint, children, actions }: { id: string; title: string; hint?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <Card className="overflow-hidden p-0" data-slot={`gstr9-${id}`}>
      <div className="flex flex-wrap items-start gap-2 border-b bg-muted/30 px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{title}</p>
          {hint && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
        </div>
        {actions}
      </div>
      <div className="overflow-x-auto thin-scroll">{children}</div>
    </Card>
  );
}

interface HeadsRow { ref: string; label: string; v: H; strong?: boolean; sub?: boolean; note?: string }

/** Taxable value and the four heads, in the form's own column order. */
function HeadsTable({ rows, taxable = true }: { rows: HeadsRow[]; taxable?: boolean }) {
  return (
    <table className="w-full min-w-[820px] text-sm">
      <thead>
        <tr className="border-b">
          <th className={`${th} w-14 text-left`}>Pt.</th>
          <th className={`${th} text-left`}>Nature of supplies</th>
          {taxable && <th className={`${th} text-right`}>Taxable value</th>}
          <th className={`${th} text-right`}>Central tax</th>
          <th className={`${th} text-right`}>State / UT tax</th>
          <th className={`${th} text-right`}>Integrated tax</th>
          <th className={`${th} text-right`}>Cess</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.ref}-${r.label}`} data-slot={`g9-${r.ref}`} className={cn('border-b last:border-0', r.strong && 'bg-muted/40 font-semibold')}>
            <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">{r.ref}</td>
            <td className={cn('px-3 py-1.5', r.sub && 'pl-8 text-muted-foreground')}>
              {r.label}
              {r.note && <span className="block text-[11px] text-muted-foreground">{r.note}</span>}
            </td>
            {taxable && <td className={td} data-col="taxable"><Money value={r.v.taxablePaise} showZero={false} /></td>}
            <td className={td} data-col="cgst"><Money value={r.v.cgstPaise} showZero={false} /></td>
            <td className={td} data-col="sgst"><Money value={r.v.sgstPaise} showZero={false} /></td>
            <td className={td} data-col="igst"><Money value={r.v.igstPaise} showZero={false} /></td>
            <td className={td} data-col="cess"><Money value={r.v.cessPaise} showZero={false} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ValueTable({ rows }: { rows: { ref: string; label: string; paise: number; strong?: boolean }[] }) {
  return (
    <table className="w-full min-w-[620px] text-sm">
      <thead>
        <tr className="border-b">
          <th className={`${th} w-14 text-left`}>Pt.</th>
          <th className={`${th} text-left`}>Nature of supplies</th>
          <th className={`${th} text-right`}>Taxable value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.ref} data-slot={`g9-${r.ref}`} className={cn('border-b last:border-0', r.strong && 'bg-muted/40 font-semibold')}>
            <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">{r.ref}</td>
            <td className="px-3 py-1.5">{r.label}</td>
            <td className={td} data-col="taxable"><Money value={r.paise} showZero={false} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HsnTable({ rows, empty }: { rows: Gstr9AnnualHsnRow[]; empty: string }) {
  return (
    <table className="w-full min-w-[900px] text-sm">
      <thead>
        <tr className="border-b">
          <th className={`${th} text-left`}>HSN code</th>
          <th className={`${th} text-left`}>Description</th>
          <th className={`${th} text-left`}>UQC</th>
          <th className={`${th} text-right`}>Total quantity</th>
          <th className={`${th} text-right`}>Taxable value</th>
          <th className={`${th} text-right`}>Rate</th>
          <th className={`${th} text-right`}>Central tax</th>
          <th className={`${th} text-right`}>State / UT tax</th>
          <th className={`${th} text-right`}>Integrated tax</th>
          <th className={`${th} text-right`}>Cess</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && <tr><td colSpan={10} className="px-3 py-4 text-center text-sm text-muted-foreground">{empty}</td></tr>}
        {rows.map((r) => (
          <tr key={`${r.code}-${r.uqc}-${r.ratePct}`} className="border-b last:border-0" data-slot={`g9-hsn-${r.code}`}>
            <td className="px-3 py-1.5 font-mono text-xs">
              {r.code}
              {r.code === 'UNCLASSIFIED' && <Badge variant="outline" className="ml-2 border-destructive/40 text-[9px]">Missing</Badge>}
            </td>
            <td className="px-3 py-1.5 text-xs text-muted-foreground">{r.description ?? '—'}</td>
            <td className="px-3 py-1.5 text-xs">{r.uqc}</td>
            <td className={td}>{r.qty}</td>
            <td className={td} data-col="taxable"><Money value={r.taxablePaise} /></td>
            <td className={td}>{r.ratePct}%</td>
            <td className={td}><Money value={r.cgstPaise} showZero={false} /></td>
            <td className={td}><Money value={r.sgstPaise} showZero={false} /></td>
            <td className={td}><Money value={r.igstPaise} showZero={false} /></td>
            <td className={td}><Money value={r.cessPaise} showZero={false} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const T15: { key: keyof Gstr9AnnualInputs['table15']; ref: string; label: string }[] = [
  { key: 'refundClaimed', ref: '15A', label: 'Total refund claimed' },
  { key: 'refundSanctioned', ref: '15B', label: 'Total refund sanctioned' },
  { key: 'refundRejected', ref: '15C', label: 'Total refund rejected' },
  { key: 'refundPending', ref: '15D', label: 'Total refund pending' },
  { key: 'demand', ref: '15E', label: 'Total demand of taxes' },
  { key: 'demandPaid', ref: '15F', label: 'Total taxes paid in respect of E above' },
  { key: 'demandPending', ref: '15G', label: 'Total demands pending out of E above' },
];
const T15_COLS = [
  ['cgstPaise', 'Central tax'], ['sgstPaise', 'State / UT tax'], ['igstPaise', 'Integrated tax'], ['cessPaise', 'Cess'],
  ['interestPaise', 'Interest'], ['penaltyPaise', 'Penalty'], ['lateFeePaise', 'Late fee / others'],
] as const;

export default function Gstr9Page() {
  const [fy, setFy] = useState(currentFy() - 1);
  useUrlPeriod((v) => setFy(Number(v)), 'fy', /^\d{4}$/);
  const state = useApi<Gstr9Annual>(() => gstr9Annual.get(fy), [fy]);
  const years = useMemo(() => Array.from({ length: 6 }, (_, i) => currentFy() - i), []);
  const canEdit = usePermission('gst', 'edit');
  const [editing, setEditing] = useState(false);
  const del = useConfirmDelete();

  const downloadFile = async (d: Gstr9Annual) => {
    try {
      const file = await gstr9Annual.file(fy);
      downloadJson(`GSTR9_${d.gstin ?? 'GSTIN'}_${d.fy}.json`, file);
      toast.success('GSTR-9 file downloaded', { description: 'In the GSTN offline tool\'s format: open it in the tool, or upload it on gst.gov.in → Returns → Annual Return → GSTR-9 → Prepare offline.' });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not build the file');
    }
  };

  const removeInputs = () => del.ask({ reasonRequired: true,
    title: `Delete the GSTR-9 entries for FY ${fyLabel(fy)}?`,
    description: 'Transition credit, other credit and reversals, table 15 and the late fee paid go back to nil. The rest of the return is worked out from the documents and does not change.',
    run: () => gstr9Annual.deleteInputs(fy),
    done: 'GSTR-9 entries deleted',
    onDone: () => state.refetch(),
  });

  return (
    <>
      <PageHeader
        title="GSTR-9 — annual return"
        description="The year restated from your documents, table by table as the form lays it out. Table 9 is the year's GSTR-3B returns added up."
        actions={
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <Select value={String(fy)} onValueChange={(v) => setFy(Number(v))}>
              <SelectTrigger className="h-8 w-48" data-slot="gstr9-fy"><SelectValue /></SelectTrigger>
              <SelectContent>
                {years.map((y) => <SelectItem key={y} value={String(y)}>FY {fyLabel(y)}{y === currentFy() ? ' (draft, year running)' : ''}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button asChild size="sm" variant="outline" className="gap-1.5">
              <Link href="/gst/gstr9c" data-slot="gstr9-to-9c"><Scale className="size-3.5" /> GSTR-9C reconciliation</Link>
            </Button>
            {state.data && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" className="gap-1.5" data-slot="gstr9-export"><Download className="size-3.5" /> Export <ChevronDown className="size-3" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem data-slot="gstr9-export-json" onClick={() => state.data && downloadFile(state.data)}><FileJson className="mr-2 size-3.5" /> Return file (JSON, offline tool)</DropdownMenuItem>
                  <DropdownMenuItem data-slot="gstr9-export-excel" onClick={() => state.data && exportExcel(state.data)}><FileSpreadsheet className="mr-2 size-3.5" /> Excel</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => window.print()}><Printer className="mr-2 size-3.5" /> Print or save as PDF</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        }
      />

      <AsyncPage state={state} loading={<LoadingRows rows={14} />}>
        {(d) => {
          const t4 = d.table4; const t5 = d.table5; const t6 = d.table6; const t7 = d.table7; const t8 = d.table8;
          const lateFee = d.table19;
          return (
            <>
              <Card className="grid gap-x-6 gap-y-3 p-4 text-sm sm:grid-cols-2 lg:grid-cols-5" data-slot="gstr9-head">
                <div><p className="micro-label">GSTIN</p><p className="mt-0.5 font-mono">{d.gstin ?? 'Not set'}</p></div>
                <div className="lg:col-span-2"><p className="micro-label">Legal name</p><p className="mt-0.5">{d.legalName}{d.tradeName ? <span className="text-muted-foreground"> · {d.tradeName}</span> : null}</p></div>
                <div><p className="micro-label">Financial year</p><p className="mt-0.5">FY {d.fy} <span className="text-muted-foreground">({longDay(d.from)} – {longDay(d.to)})</span></p></div>
                <div>
                  <p className="micro-label">Return</p>
                  <div className="mt-0.5 flex flex-wrap gap-1.5">
                    {d.draft ? <Badge variant="outline" data-slot="gstr9-draft">Draft · year running</Badge> : <Badge variant="outline">Year ended</Badge>}
                    {d.isNil && <Badge variant="outline" data-slot="gstr9-nil">Nil return</Badge>}
                    <span className="text-xs text-muted-foreground">Due {longDay(lateFee.dueDate)}</span>
                  </div>
                </div>
              </Card>

              <ReturnFilingBar returnType="gstr9" period={String(d.startYear)} title="GSTR-9" onChange={() => state.refetch()} />

              <Card className="flex items-start gap-3 p-4" data-slot="gstr9-notes">
                <Info className="mt-0.5 size-4 shrink-0 text-primary" />
                <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
                  {d.notes.map((n) => <p key={n}>{n}</p>)}
                </div>
              </Card>

              {d.isNil && (
                <Card className="p-4 text-sm text-muted-foreground" data-slot="gstr9-empty">
                  Nothing was sold, bought or claimed in FY {d.fy}, so this is a nil return. Record the year&apos;s invoices (Sales → Invoices), bills (Purchases → Bills)
                  and credit notes, and every table below fills in from them.
                </Card>
              )}

              <p className="pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pt. II — Outward and inward supplies made during the financial year</p>

              <Part id="table4" title="4. Details of advances, inward and outward supplies made during the financial year on which tax is payable"
                hint="From the year's invoices, debit and credit notes (B2C notes net into 4A, as the B2CS summary nets them), advances for services (GSTR-1 tables 11A less 11B) and reverse-charge bills.">
                <HeadsTable rows={[
                  { ref: '4A', label: 'Supplies made to un-registered persons (B2C)', v: t4.b2c },
                  { ref: '4B', label: 'Supplies made to registered persons (B2B)', v: t4.b2b },
                  { ref: '4C', label: 'Zero rated supply (export) on payment of tax (except supplies to SEZs)', v: t4.exportsWithTax },
                  { ref: '4D', label: 'Supply to SEZs on payment of tax', v: t4.sezWithTax },
                  { ref: '4E', label: 'Deemed exports', v: t4.deemedExports },
                  { ref: '4F', label: 'Advances on which tax has been paid but invoice has not been issued (not covered under (A) to (E) above)', v: t4.advances },
                  { ref: '4G', label: 'Inward supplies on which tax is to be paid on reverse charge basis', v: t4.rcmInward },
                  { ref: '4G1', label: 'Supplies on which e-commerce operator is required to pay tax as per section 9(5)', v: t4.ecoPays },
                  { ref: '4H', label: 'Sub-total (A to G1 above)', v: t4.subtotalAG, strong: true },
                  { ref: '4I', label: 'Credit notes issued in respect of transactions specified in (B) to (E) above (−)', v: t4.creditNotes },
                  { ref: '4J', label: 'Debit notes issued in respect of transactions specified in (B) to (E) above (+)', v: t4.debitNotes },
                  { ref: '4K', label: 'Supplies / tax declared through amendments (+)', v: t4.amendmentsPlus },
                  { ref: '4L', label: 'Supplies / tax reduced through amendments (−)', v: t4.amendmentsMinus },
                  { ref: '4M', label: 'Sub-total (I to L above)', v: t4.subtotalIL, strong: true },
                  { ref: '4N', label: 'Supplies and advances on which tax is to be paid (H + M) above', v: t4.total, strong: true },
                ]} />
              </Part>

              <Part id="table5" title="5. Details of outward supplies made during the financial year on which tax is not payable"
                hint="Exports and SEZ supplies under a LUT, supplies on which the buyer pays the tax, exempt, nil-rated and non-GST lines (by the item's tax preference), and the notes on them.">
                <ValueTable rows={[
                  { ref: '5A', label: 'Zero rated supply (export) without payment of tax', paise: t5.zeroRated },
                  { ref: '5B', label: 'Supply to SEZs without payment of tax', paise: t5.sez },
                  { ref: '5C', label: 'Supplies on which tax is to be paid by the recipient on reverse charge basis', paise: t5.reverseCharge },
                  { ref: '5C1', label: 'Supplies on which e-commerce operator is required to pay tax as per section 9(5)', paise: t5.ecoSupplies },
                  { ref: '5D', label: 'Exempted', paise: t5.exempt },
                  { ref: '5E', label: 'Nil rated', paise: t5.nil },
                  { ref: '5F', label: 'Non-GST supply (includes \'no supply\')', paise: t5.nonGst },
                  { ref: '5G', label: 'Sub-total (A to F above)', paise: t5.subtotalAF, strong: true },
                  { ref: '5H', label: 'Credit notes issued in respect of transactions specified in A to F above (−)', paise: t5.creditNotes },
                  { ref: '5I', label: 'Debit notes issued in respect of transactions specified in A to F above (+)', paise: t5.debitNotes },
                  { ref: '5J', label: 'Supplies declared through amendments (+)', paise: t5.amendmentsPlus },
                  { ref: '5K', label: 'Supplies reduced through amendments (−)', paise: t5.amendmentsMinus },
                  { ref: '5L', label: 'Sub-total (H to K above)', paise: t5.subtotalHK, strong: true },
                  { ref: '5M', label: 'Turnover on which tax is not to be paid (G + L above)', paise: t5.notTaxable, strong: true },
                  { ref: '5N', label: 'Total turnover (including advances) (4N + 5M − 4G above)', paise: t5.totalTurnover, strong: true },
                ]} />
              </Part>

              <p className="pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pt. III — Input tax credit as declared in returns filed during the financial year</p>

              <Part id="table6" title="6. Details of ITC availed during the financial year"
                hint={<>6A is GSTR-3B table 4(A) for the year&apos;s {d.table9Other.periods.length} return periods. 6B to 6H are the bills, expenses and bills of entry behind it, in the month their credit was claimed after matching GSTR-2B; 6J is the difference between the two and is nil when they agree. Blocked credit is shown here and reversed in 7E.</>}>
                <HeadsTable taxable={false} rows={[
                  { ref: '6A', label: 'Total amount of input tax credit availed through GSTR-3B (sum total of table 4A of GSTR-3B)', v: t6.itc3b, strong: true },
                  { ref: '6A1', label: 'ITC of the preceding financial year availed in this year\'s GSTR-3B', v: t6.previousYear, sub: true },
                  { ref: '6A2', label: 'Net ITC of this financial year (6A − 6A1)', v: t6.thisYear, sub: true },
                  { ref: '6B', label: 'Inward supplies (other than imports and reverse charge) — inputs', v: t6.inward.inputs },
                  { ref: '6B', label: '— capital goods', v: t6.inward.capitalGoods, sub: true },
                  { ref: '6B', label: '— input services', v: t6.inward.inputServices, sub: true },
                  { ref: '6C', label: 'Inward supplies from unregistered persons liable to reverse charge — inputs', v: t6.rcmUnregistered.inputs },
                  { ref: '6C', label: '— capital goods', v: t6.rcmUnregistered.capitalGoods, sub: true },
                  { ref: '6C', label: '— input services', v: t6.rcmUnregistered.inputServices, sub: true },
                  { ref: '6D', label: 'Inward supplies from registered persons liable to reverse charge — inputs', v: t6.rcmRegistered.inputs },
                  { ref: '6D', label: '— capital goods', v: t6.rcmRegistered.capitalGoods, sub: true },
                  { ref: '6D', label: '— input services', v: t6.rcmRegistered.inputServices, sub: true },
                  { ref: '6E', label: 'Import of goods (including supplies from SEZs) — inputs', v: t6.importGoods.inputs },
                  { ref: '6E', label: '— capital goods', v: t6.importGoods.capitalGoods, sub: true },
                  { ref: '6F', label: 'Import of services (excluding inward supplies from SEZs)', v: t6.importServices },
                  { ref: '6G', label: 'Input tax credit received from ISD', v: t6.isd },
                  { ref: '6H', label: 'Amount of ITC reclaimed (other than B above) under the provisions of the Act', v: t6.reclaimed },
                  { ref: '6I', label: 'Sub-total (B to H above)', v: t6.subtotalBH, strong: true },
                  { ref: '6J', label: 'Difference (I − A2 above)', v: t6.difference, strong: true },
                  { ref: '6K', label: 'Transition credit through TRAN-I (including revisions if any)', v: t6.tran1, note: 'Entered by the preparer' },
                  { ref: '6L', label: 'Transition credit through TRAN-II', v: t6.tran2, note: 'Entered by the preparer' },
                  { ref: '6M', label: 'Any other ITC availed but not specified above', v: t6.other, note: t6.otherDetail.map((o) => o.description).join(', ') || 'Entered by the preparer' },
                  { ref: '6N', label: 'Sub-total (K to M above)', v: t6.subtotalKM, strong: true },
                  { ref: '6O', label: 'Total ITC availed (I + N above)', v: t6.total, strong: true },
                ]} />
              </Part>

              <Part id="table7" title="7. Details of ITC reversed and ineligible ITC as declared in returns filed during the financial year"
                hint="From the ITC reversal registers (Rule 37 unpaid suppliers, Rules 42 and 43 common credit, the year's true-up) and the blocked lines of bills and bills of entry (section 17(5)).">
                <HeadsTable taxable={false} rows={[
                  { ref: '7A', label: 'As per Rule 37', v: t7.rule37 },
                  { ref: '7B', label: 'As per Rule 39', v: t7.rule39 },
                  { ref: '7C', label: 'As per Rule 42', v: t7.rule42 },
                  { ref: '7D', label: 'As per Rule 43', v: t7.rule43 },
                  { ref: '7E', label: 'As per section 17(5)', v: t7.section17_5 },
                  { ref: '7F', label: 'Reversal of TRAN-I credit', v: t7.tran1, note: 'Entered by the preparer' },
                  { ref: '7G', label: 'Reversal of TRAN-II credit', v: t7.tran2, note: 'Entered by the preparer' },
                  { ref: '7H', label: 'Other reversals', v: t7.other, note: t7.otherDetail.map((o) => o.description).join(', ') || 'Entered by the preparer' },
                  { ref: '7I', label: 'Total ITC reversed (sum of A to H above)', v: t7.total, strong: true },
                  { ref: '7J', label: 'Net ITC available for utilization (6O − 7I)', v: t7.netAvailable, strong: true },
                ]} />
              </Part>

              <Part id="table8" title="8. Other ITC related information"
                hint="8A is the GSTR-2B brought in for the year's twelve periods (lines accepted, or with no IMS action, excluding reverse charge). 8C is credit on this year's bills claimed in the next year's returns up to 30 November; 8E is credit not claimed by then.">
                <HeadsTable taxable={false} rows={[
                  { ref: '8A', label: 'ITC as per GSTR-2B', v: t8.asPer2b },
                  { ref: '8B', label: 'ITC as per sum total of 6(B) and 6(H) above', v: t8.asPerTable6 },
                  { ref: '8C', label: 'ITC on inward supplies (other than imports and reverse charge) received during the year but availed in the next year up to 30 November', v: t8.nextYear },
                  { ref: '8D', label: 'Difference [A − (B + C)]', v: t8.difference, strong: true },
                  { ref: '8E', label: 'ITC available but not availed', v: t8.notAvailed },
                  { ref: '8F', label: 'ITC available but ineligible', v: t8.ineligible },
                  { ref: '8G', label: 'IGST paid on import of goods (including supplies from SEZ)', v: t8.importIgstPaid },
                  { ref: '8H', label: 'IGST credit availed on import of goods (as per 6(E) above)', v: t8.importIgstAvailed },
                  { ref: '8I', label: 'Difference (G − H)', v: t8.importDifference, strong: true },
                  { ref: '8J', label: 'ITC available but not availed on import of goods (equal to I)', v: t8.importNotAvailed },
                  { ref: '8K', label: 'Total ITC to be lapsed in the current financial year (E + F + J)', v: t8.lapsed, strong: true },
                ]} />
              </Part>

              <p className="pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pt. IV — Details of tax paid as declared in returns filed during the financial year</p>

              <Part id="table9" title="9. Details of tax paid as declared in returns filed during the financial year"
                hint={d.table9Other.recordedPayments
                  ? `${d.table9Other.recordedPayments} of ${d.table9Other.periods.length} GSTR-3B periods have their payment recorded; those show what was paid. The rest show what each return works out, credit set off in the order of section 49(5) and Rule 88A.`
                  : 'Each GSTR-3B of the year, added up: the liability, the credit set off in the order of section 49(5) and Rule 88A, and the cash. Recording a return\'s payment on GSTR-3B makes this show what was actually paid.'}>
                <table className="w-full min-w-[900px] text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className={`${th} text-left`}>Description</th>
                      <th className={`${th} text-right`}>Tax payable</th>
                      <th className={`${th} text-right`}>Paid through cash</th>
                      <th className={`${th} text-right`}>ITC: Central tax</th>
                      <th className={`${th} text-right`}>ITC: State / UT tax</th>
                      <th className={`${th} text-right`}>ITC: Integrated tax</th>
                      <th className={`${th} text-right`}>ITC: Cess</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.table9.map((r) => (
                      <tr key={r.head} className="border-b" data-slot={`g9-9-${r.head}`}>
                        <td className="px-3 py-1.5">{r.head === 'IGST' ? 'Integrated tax' : r.head === 'CGST' ? 'Central tax' : r.head === 'SGST' ? 'State / UT tax' : 'Cess'}</td>
                        <td className={td} data-col="payable"><Money value={r.payablePaise} showZero={false} /></td>
                        <td className={td} data-col="cash"><Money value={r.paidInCashPaise} showZero={false} /></td>
                        {(['CGST', 'SGST', 'IGST', 'CESS'] as const).map((c) => {
                          // Which credit may meet which head (section 49(5)): CGST and SGST never cross; cess only cess.
                          const barred = (r.head === 'CESS') !== (c === 'CESS') || (r.head === 'CGST' && c === 'SGST') || (r.head === 'SGST' && c === 'CGST');
                          return <td key={c} className={td}>{barred ? <span className="text-muted-foreground/40">—</span> : <Money value={r.itc[c]} showZero={false} />}</td>;
                        })}
                      </tr>
                    ))}
                    {([['Interest', d.table9Other.interest], ['Late fee', d.table9Other.lateFee], ['Penalty', d.table9Other.penalty], ['Other', d.table9Other.other]] as const).map(([label, v]) => (
                      <tr key={label} className="border-b last:border-0">
                        <td className="px-3 py-1.5">{label}</td>
                        <td className={td}><Money value={v.payablePaise} showZero={false} /></td>
                        <td className={td}><Money value={v.paidPaise} showZero={false} /></td>
                        <td colSpan={4} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Part>

              <p className="pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pt. V — Transactions of this year declared in the next year&apos;s returns up to 30 November</p>

              <Part id="table10" title="10 to 13. This year's supplies and credit in the next year's returns"
                hint={`Debit and credit notes dated from ${longDay(`${d.startYear + 1}-04-01`)} to ${longDay(`${d.startYear + 1}-11-30`)} against this year's invoices; the next year's vendor credits and Rule 37 reversals on this year's bills; and this year's credit claimed in those months (sections 16(4) and 34(2)).`}>
                <HeadsTable rows={[
                  { ref: '10', label: 'Supplies / tax declared through amendments (+) (net of debit notes)', v: d.table10 },
                  { ref: '11', label: 'Supplies / tax reduced through amendments (−) (net of credit notes)', v: d.table11 },
                  { ref: '12', label: 'Reversal of ITC availed during the previous financial year', v: d.table12 },
                  { ref: '13', label: 'ITC availed for the previous financial year', v: d.table13 },
                ]} />
              </Part>

              <Part id="table14" title="14. Differential tax paid on account of declaration in 10 and 11 above">
                <table className="w-full min-w-[520px] text-sm">
                  <thead>
                    <tr className="border-b"><th className={`${th} text-left`}>Description</th><th className={`${th} text-right`}>Payable</th><th className={`${th} text-right`}>Paid</th></tr>
                  </thead>
                  <tbody>
                    {d.table14.map((r) => (
                      <tr key={r.head} className="border-b last:border-0">
                        <td className="px-3 py-1.5">{r.head === 'IGST' ? 'Integrated tax' : r.head === 'CGST' ? 'Central tax' : r.head === 'SGST' ? 'State / UT tax' : r.head === 'CESS' ? 'Cess' : 'Interest'}</td>
                        <td className={td}><Money value={r.payablePaise} showZero={false} /></td>
                        <td className={td}><Money value={r.paidPaise} showZero={false} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Part>

              <p className="pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pt. VI — Other information</p>

              <Part id="table15" title="15. Particulars of demands and refunds"
                hint="Not kept in the books: enter them from the refund and demand orders. They can be edited or deleted at any time before filing."
                actions={canEdit ? (
                  <div className="flex gap-1.5 print:hidden">
                    <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => setEditing(true)} data-slot="gstr9-inputs-edit"><Pencil className="size-3.5" /> Edit</Button>
                    <Button size="sm" variant="outline" className="h-7 gap-1" onClick={removeInputs} data-slot="gstr9-inputs-delete"><Trash2 className="size-3.5" /> Delete</Button>
                  </div>
                ) : undefined}>
                <table className="w-full min-w-[980px] text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className={`${th} w-14 text-left`}>Pt.</th>
                      <th className={`${th} text-left`}>Details</th>
                      {T15_COLS.map(([, l]) => <th key={l} className={`${th} text-right`}>{l}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {T15.map((r) => (
                      <tr key={r.ref} className="border-b last:border-0" data-slot={`g9-${r.ref}`}>
                        <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">{r.ref}</td>
                        <td className="px-3 py-1.5">{r.label}</td>
                        {T15_COLS.map(([k]) => <td key={k} className={td} data-col={k}><Money value={d.table15[r.key][k]} showZero={false} /></td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Part>

              <Part id="table16" title="16. Information on supplies received from composition taxpayers, deemed supply under section 143 and goods sent on approval basis"
                hint="16A: bills from suppliers registered under composition. 16B: goods sent to a job worker not back within a year of the challan (s.143(3)). 16C: goods sent on approval neither returned nor invoiced within six months (s.31(7)).">
                <HeadsTable rows={[
                  { ref: '16A', label: 'Supplies received from composition taxpayers', v: { ...ZERO, taxablePaise: d.table16.composition } },
                  { ref: '16B', label: 'Deemed supply under section 143', v: d.table16.deemedSupply },
                  { ref: '16C', label: 'Goods sent on approval basis but not returned', v: d.table16.approval },
                ]} />
              </Part>

              <Part id="table17" title="17. HSN wise summary of outward supplies"
                hint={`Sales less credit notes, by HSN at ${d.hsnDigits} digits (${d.aatoAbove5Cr ? 'turnover above ₹5 crore' : 'turnover up to ₹5 crore'}, Notification 78/2020-CT), unit and rate. Services show UQC NA.`}>
                <HsnTable rows={d.table17} empty="No sales in the year. Raise invoices with HSN codes and they are summarised here." />
              </Part>
              <Part id="table18" title="18. HSN wise summary of inward supplies" hint={`Bills, by HSN at ${d.hsnDigits} digits, unit and rate.`}>
                <HsnTable rows={d.table18} empty="No bills in the year. Record purchase bills with HSN codes and they are summarised here." />
              </Part>

              <Part id="table19" title="19. Late fee payable and paid" hint={lateFee.basis}>
                <table className="w-full min-w-[520px] text-sm">
                  <thead>
                    <tr className="border-b"><th className={`${th} text-left`}>Description</th><th className={`${th} text-right`}>Payable</th><th className={`${th} text-right`}>Paid</th></tr>
                  </thead>
                  <tbody>
                    <tr className="border-b"><td className="px-3 py-1.5">Central tax</td><td className={td}><Money value={lateFee.cgst.payablePaise} /></td><td className={td}><Money value={lateFee.cgst.paidPaise} /></td></tr>
                    <tr><td className="px-3 py-1.5">State / UT tax</td><td className={td}><Money value={lateFee.sgst.payablePaise} /></td><td className={td}><Money value={lateFee.sgst.paidPaise} /></td></tr>
                  </tbody>
                </table>
              </Part>

              <Part id="tieout" title="Tie-out to the general ledger"
                hint="The GST ledgers for the year, counting only what documents posted (a payment or set-off entry clears the ledgers and is not a supply or a claim), against the return. Any difference is listed with its reason; what no reason covers is the unexplained amount.">
                <table className="w-full min-w-[900px] text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className={`${th} text-left`}>Ledgers</th>
                      <th className={`${th} text-right`}>Books</th>
                      <th className={`${th} text-right`}>Return</th>
                      <th className={`${th} text-right`}>Difference</th>
                      <th className={`${th} text-left`}>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.tieOut.map((t) => (
                      <tr key={t.key} className="border-b align-top last:border-0" data-slot={`g9-tie-${t.key}`}>
                        <td className="px-3 py-1.5">{t.label}</td>
                        <td className={td} data-col="books"><Money value={t.booksPaise} /></td>
                        <td className={td} data-col="return"><Money value={t.returnPaise} /></td>
                        <td className={cn(td, t.unexplainedPaise !== 0 && 'text-destructive')} data-col="difference"><Money value={t.differencePaise} /></td>
                        <td className="px-3 py-1.5 text-xs text-muted-foreground">
                          {t.reasons.length === 0 && t.differencePaise === 0 && <span className="text-emerald-700 dark:text-emerald-400" data-slot="g9-tie-ok">Agrees to the paisa.</span>}
                          {t.reasons.map((r) => <span key={r.label} className="block">{r.label}: <Money value={r.paise} /></span>)}
                          {t.unexplainedPaise !== 0 && <span className="block text-destructive">Unexplained: <Money value={t.unexplainedPaise} /></span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Part>

              {editing && (
                <InputsDialog fy={d.startYear} inputs={d.inputs} onClose={() => setEditing(false)} onDone={() => { setEditing(false); state.refetch(); }} />
              )}
              {del.dialog}
            </>
          );
        }}
      </AsyncPage>
    </>
  );
}

// ── The preparer's rows ──────────────────────────────────────────────────────

const toPaise = (v: string) => {
  const n = Number(v.replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
};
const show = (paise: number) => (paise ? String(paise / 100) : '');

function Amount({ label, value, onChange, slot }: { label: string; value: number; onChange: (p: number) => void; slot?: string }) {
  const [text, setText] = useState(show(value));
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input inputMode="decimal" value={text} data-slot={slot} className="h-8 text-right tabular"
        onChange={(e) => { setText(e.target.value); onChange(toPaise(e.target.value)); }} placeholder="0.00" />
    </div>
  );
}

function InputsDialog({ fy, inputs, onClose, onDone }: { fy: number; inputs: Gstr9AnnualInputs; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState<Gstr9AnnualInputs>(() => structuredClone(inputs));
  const [busy, setBusy] = useState(false);
  const set = (fn: (x: Gstr9AnnualInputs) => void) => setV((cur) => { const n = structuredClone(cur); fn(n); return n; });
  const save = async () => {
    setBusy(true);
    try {
      await gstr9Annual.saveInputs(fy, {
        ...v,
        otherItc: v.otherItc.filter((o) => o.description.trim()),
        otherReversals: v.otherReversals.filter((o) => o.description.trim()),
      });
      toast.success('GSTR-9 entries saved');
      onDone();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };
  const other = (key: 'otherItc' | 'otherReversals', title: string) => (
    <div className="space-y-2">
      <p className="text-xs font-semibold">{title}</p>
      {v[key].map((o, i) => (
        <div key={i} className="grid grid-cols-[1fr_repeat(4,6rem)_auto] items-end gap-2">
          <div className="space-y-1"><Label className="text-[11px] text-muted-foreground">Description</Label>
            <Input className="h-8" value={o.description} onChange={(e) => set((x) => { x[key][i].description = e.target.value; })} /></div>
          <Amount label="IGST" value={o.igstPaise} onChange={(p) => set((x) => { x[key][i].igstPaise = p; })} />
          <Amount label="CGST" value={o.cgstPaise} onChange={(p) => set((x) => { x[key][i].cgstPaise = p; })} />
          <Amount label="SGST" value={o.sgstPaise} onChange={(p) => set((x) => { x[key][i].sgstPaise = p; })} />
          <Amount label="Cess" value={o.cessPaise} onChange={(p) => set((x) => { x[key][i].cessPaise = p; })} />
          <Button size="sm" variant="outline" className="h-8 gap-1" onClick={() => set((x) => { x[key].splice(i, 1); })}><Trash2 className="size-3.5" /> Delete</Button>
        </div>
      ))}
      <Button size="sm" variant="outline" className="h-7" onClick={() => set((x) => { x[key].push({ description: '', igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0 }); })}>Add a line</Button>
    </div>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>GSTR-9 entries for FY {fyLabel(fy)}</DialogTitle>
          <DialogDescription>The rows no document in the books can supply. Amounts in rupees; leave a box empty for nil.</DialogDescription>
        </DialogHeader>
        <div className="space-y-5 text-sm">
          <div className="space-y-2" data-slot="gstr9-inputs-15">
            <p className="text-xs font-semibold">Table 15 — demands and refunds</p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px]">
                <thead><tr><th className={`${th} text-left`}>Row</th>{T15_COLS.map(([, l]) => <th key={l} className={`${th} text-right`}>{l}</th>)}</tr></thead>
                <tbody>
                  {T15.map((r) => (
                    <tr key={r.key}>
                      <td className="py-1 pr-2 text-xs">{r.ref} {r.label}</td>
                      {T15_COLS.map(([k]) => (
                        <td key={k} className="px-1 py-1">
                          <Amount label="" value={v.table15[r.key][k]} slot={`g9-in-${r.ref}-${k}`}
                            onChange={(p) => set((x) => { x.table15[r.key][k] = p; })} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <Amount label="6K TRAN-I credit — CGST" value={v.tran1.cgstPaise} onChange={(p) => set((x) => { x.tran1.cgstPaise = p; })} />
            <Amount label="6K TRAN-I credit — SGST" value={v.tran1.sgstPaise} onChange={(p) => set((x) => { x.tran1.sgstPaise = p; })} />
            <Amount label="6L TRAN-II credit — CGST" value={v.tran2.cgstPaise} onChange={(p) => set((x) => { x.tran2.cgstPaise = p; })} />
            <Amount label="6L TRAN-II credit — SGST" value={v.tran2.sgstPaise} onChange={(p) => set((x) => { x.tran2.sgstPaise = p; })} />
            <Amount label="7F TRAN-I reversed — CGST" value={v.tran1Reversed.cgstPaise} onChange={(p) => set((x) => { x.tran1Reversed.cgstPaise = p; })} />
            <Amount label="7F TRAN-I reversed — SGST" value={v.tran1Reversed.sgstPaise} onChange={(p) => set((x) => { x.tran1Reversed.sgstPaise = p; })} />
            <Amount label="7G TRAN-II reversed — CGST" value={v.tran2Reversed.cgstPaise} onChange={(p) => set((x) => { x.tran2Reversed.cgstPaise = p; })} />
            <Amount label="7G TRAN-II reversed — SGST" value={v.tran2Reversed.sgstPaise} onChange={(p) => set((x) => { x.tran2Reversed.sgstPaise = p; })} />
          </div>
          {other('otherItc', '6M — any other ITC availed but not specified above')}
          {other('otherReversals', '7H — other reversals')}
          <div className="grid gap-3 sm:grid-cols-4">
            <Amount label="19 Late fee paid — CGST" value={v.lateFeePaid.cgstPaise} slot="g9-in-19-cgst" onChange={(p) => set((x) => { x.lateFeePaid.cgstPaise = p; })} />
            <Amount label="19 Late fee paid — SGST" value={v.lateFeePaid.sgstPaise} slot="g9-in-19-sgst" onChange={(p) => set((x) => { x.lateFeePaid.sgstPaise = p; })} />
            <Amount label="9 Penalty paid" value={v.penaltyPaise} onChange={(p) => set((x) => { x.penaltyPaise = p; })} />
            <Amount label="9 Other amounts paid" value={v.otherPaidPaise} onChange={(p) => set((x) => { x.otherPaidPaise = p; })} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy} data-slot="gstr9-inputs-save">{busy ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Excel ────────────────────────────────────────────────────────────────────

/** The return as a workbook, a sheet for each part of the form. */
function exportExcel(d: Gstr9Annual) {
  const rs = (p: number) => toRupees(p);
  const hd = ['Pt.', 'Nature of supplies', 'Taxable value', 'Central tax', 'State/UT tax', 'Integrated tax', 'Cess'];
  const row = (ref: string, label: string, v: H): Cell[] => [ref, label, rs(v.taxablePaise), rs(v.cgstPaise), rs(v.sgstPaise), rs(v.igstPaise), rs(v.cessPaise)];
  const t4 = d.table4; const t5 = d.table5; const t6 = d.table6; const t7 = d.table7; const t8 = d.table8;
  const head: Cell[][] = [['GSTR-9', `FY ${d.fy}`], ['GSTIN', d.gstin ?? ''], ['Legal name', d.legalName], []];
  const sheets: Sheet[] = [
    {
      name: 'Tables 4-5', widths: [6, 80, 16, 14, 14, 14, 12], rows: [
        ...head, ['4. Supplies on which tax is payable'], hd,
        row('4A', 'Supplies made to un-registered persons (B2C)', t4.b2c), row('4B', 'Supplies made to registered persons (B2B)', t4.b2b),
        row('4C', 'Zero rated supply (export) on payment of tax', t4.exportsWithTax), row('4D', 'Supply to SEZs on payment of tax', t4.sezWithTax),
        row('4E', 'Deemed exports', t4.deemedExports), row('4F', 'Advances on which tax has been paid but invoice not issued', t4.advances),
        row('4G', 'Inward supplies on reverse charge', t4.rcmInward), row('4G1', 'Supplies on which e-commerce operator pays tax u/s 9(5)', t4.ecoPays),
        row('4H', 'Sub-total (A to G1)', t4.subtotalAG), row('4I', 'Credit notes (−)', t4.creditNotes), row('4J', 'Debit notes (+)', t4.debitNotes),
        row('4K', 'Amendments (+)', t4.amendmentsPlus), row('4L', 'Amendments (−)', t4.amendmentsMinus), row('4M', 'Sub-total (I to L)', t4.subtotalIL),
        row('4N', 'Supplies and advances on which tax is to be paid (H + M)', t4.total), [],
        ['5. Supplies on which tax is not payable'], ['Pt.', 'Nature of supplies', 'Taxable value'],
        ...([['5A', 'Zero rated supply (export) without payment of tax', t5.zeroRated], ['5B', 'Supply to SEZs without payment of tax', t5.sez],
          ['5C', 'Tax payable by the recipient on reverse charge', t5.reverseCharge], ['5C1', 'E-commerce operator pays tax u/s 9(5)', t5.ecoSupplies],
          ['5D', 'Exempted', t5.exempt], ['5E', 'Nil rated', t5.nil], ['5F', 'Non-GST supply', t5.nonGst], ['5G', 'Sub-total (A to F)', t5.subtotalAF],
          ['5H', 'Credit notes (−)', t5.creditNotes], ['5I', 'Debit notes (+)', t5.debitNotes], ['5J', 'Amendments (+)', t5.amendmentsPlus],
          ['5K', 'Amendments (−)', t5.amendmentsMinus], ['5L', 'Sub-total (H to K)', t5.subtotalHK], ['5M', 'Turnover on which tax is not to be paid (G + L)', t5.notTaxable],
          ['5N', 'Total turnover (including advances) (4N + 5M − 4G)', t5.totalTurnover]] as [string, string, number][]).map(([r, l, p]) => [r, l, rs(p)]),
      ],
    },
    {
      name: 'Tables 6-8', widths: [6, 80, 16, 14, 14, 14, 12], rows: [
        ...head, ['6. ITC availed during the financial year'], hd,
        row('6A', 'ITC availed through GSTR-3B (table 4A)', t6.itc3b), row('6A1', 'ITC of the preceding year availed this year', t6.previousYear), row('6A2', 'Net ITC of this year', t6.thisYear),
        row('6B', 'Inward supplies — inputs', t6.inward.inputs), row('6B', '— capital goods', t6.inward.capitalGoods), row('6B', '— input services', t6.inward.inputServices),
        row('6C', 'Reverse charge, unregistered — inputs', t6.rcmUnregistered.inputs), row('6C', '— capital goods', t6.rcmUnregistered.capitalGoods), row('6C', '— input services', t6.rcmUnregistered.inputServices),
        row('6D', 'Reverse charge, registered — inputs', t6.rcmRegistered.inputs), row('6D', '— capital goods', t6.rcmRegistered.capitalGoods), row('6D', '— input services', t6.rcmRegistered.inputServices),
        row('6E', 'Import of goods — inputs', t6.importGoods.inputs), row('6E', '— capital goods', t6.importGoods.capitalGoods),
        row('6F', 'Import of services', t6.importServices), row('6G', 'Received from ISD', t6.isd), row('6H', 'ITC reclaimed', t6.reclaimed),
        row('6I', 'Sub-total (B to H)', t6.subtotalBH), row('6J', 'Difference (I − A2)', t6.difference), row('6K', 'TRAN-I', t6.tran1), row('6L', 'TRAN-II', t6.tran2),
        row('6M', 'Any other ITC', t6.other), row('6N', 'Sub-total (K to M)', t6.subtotalKM), row('6O', 'Total ITC availed (I + N)', t6.total), [],
        ['7. ITC reversed and ineligible ITC'], hd,
        row('7A', 'Rule 37', t7.rule37), row('7B', 'Rule 39', t7.rule39), row('7C', 'Rule 42', t7.rule42), row('7D', 'Rule 43', t7.rule43),
        row('7E', 'Section 17(5)', t7.section17_5), row('7F', 'Reversal of TRAN-I credit', t7.tran1), row('7G', 'Reversal of TRAN-II credit', t7.tran2),
        row('7H', 'Other reversals', t7.other), row('7I', 'Total ITC reversed', t7.total), row('7J', 'Net ITC available for utilization (6O − 7I)', t7.netAvailable), [],
        ['8. Other ITC related information'], hd,
        row('8A', 'ITC as per GSTR-2B', t8.asPer2b), row('8B', 'ITC as per 6(B) and 6(H)', t8.asPerTable6), row('8C', 'Availed in the next year up to 30 November', t8.nextYear),
        row('8D', 'Difference [A − (B + C)]', t8.difference), row('8E', 'Available but not availed', t8.notAvailed), row('8F', 'Available but ineligible', t8.ineligible),
        row('8G', 'IGST paid on import of goods', t8.importIgstPaid), row('8H', 'IGST availed on import of goods', t8.importIgstAvailed), row('8I', 'Difference (G − H)', t8.importDifference),
        row('8J', 'Not availed on import of goods', t8.importNotAvailed), row('8K', 'Total ITC to be lapsed (E + F + J)', t8.lapsed),
      ],
    },
    {
      name: 'Table 9', widths: [24, 16, 16, 14, 14, 14, 12], rows: [
        ...head, ['9. Details of tax paid'], ['Description', 'Tax payable', 'Paid through cash', 'ITC: Central', 'ITC: State/UT', 'ITC: Integrated', 'ITC: Cess'],
        ...d.table9.map((r) => [r.head, rs(r.payablePaise), rs(r.paidInCashPaise), rs(r.itc.CGST), rs(r.itc.SGST), rs(r.itc.IGST), rs(r.itc.CESS)]),
        ['Interest', rs(d.table9Other.interest.payablePaise), rs(d.table9Other.interest.paidPaise)],
        ['Late fee', rs(d.table9Other.lateFee.payablePaise), rs(d.table9Other.lateFee.paidPaise)],
        ['Penalty', rs(d.table9Other.penalty.payablePaise), rs(d.table9Other.penalty.paidPaise)],
        ['Other', rs(d.table9Other.other.payablePaise), rs(d.table9Other.other.paidPaise)],
      ],
    },
    {
      name: 'Tables 10-16', widths: [6, 70, 16, 14, 14, 14, 12, 12], rows: [
        ...head, ['10 to 13. In the next year\'s returns up to 30 November'], hd,
        row('10', 'Supplies / tax declared through amendments (+)', d.table10), row('11', 'Supplies / tax reduced through amendments (−)', d.table11),
        row('12', 'Reversal of ITC availed during the previous year', d.table12), row('13', 'ITC availed for the previous year', d.table13), [],
        ['14. Differential tax paid'], ['Head', 'Payable', 'Paid'], ...d.table14.map((r) => [r.head, rs(r.payablePaise), rs(r.paidPaise)]), [],
        ['15. Demands and refunds'], ['Pt.', 'Details', ...T15_COLS.map(([, l]) => l)],
        ...T15.map((r) => [r.ref, r.label, ...T15_COLS.map(([k]) => rs(d.table15[r.key][k]))]), [],
        ['16. Composition, deemed supply, approval'], hd,
        row('16A', 'Supplies received from composition taxpayers', { ...ZERO, taxablePaise: d.table16.composition }),
        row('16B', 'Deemed supply under section 143', d.table16.deemedSupply), row('16C', 'Goods sent on approval basis but not returned', d.table16.approval), [],
        ['19. Late fee'], ['Head', 'Payable', 'Paid'],
        ['Central tax', rs(d.table19.cgst.payablePaise), rs(d.table19.cgst.paidPaise)], ['State/UT tax', rs(d.table19.sgst.payablePaise), rs(d.table19.sgst.paidPaise)],
      ],
    },
    ...([['HSN outward (17)', d.table17], ['HSN inward (18)', d.table18]] as const).map(([name, rows]) => ({
      name, widths: [12, 30, 8, 12, 16, 8, 14, 14, 14, 12],
      rows: [...head, ['HSN', 'Description', 'UQC', 'Quantity', 'Taxable value', 'Rate %', 'Central tax', 'State/UT tax', 'Integrated tax', 'Cess'],
        ...rows.map((r) => [r.code, r.description ?? '', r.uqc, r.qty, rs(r.taxablePaise), r.ratePct, rs(r.cgstPaise), rs(r.sgstPaise), rs(r.igstPaise), rs(r.cessPaise)] as Cell[])],
    })),
    {
      name: 'GL tie-out', widths: [70, 16, 16, 16, 60], rows: [
        ...head, ['Ledgers', 'Books', 'Return', 'Difference', 'Why'],
        ...d.tieOut.map((t) => [t.label, rs(t.booksPaise), rs(t.returnPaise), rs(t.differencePaise),
          [...t.reasons.map((r) => `${r.label}: ${rs(r.paise)}`), t.unexplainedPaise ? `Unexplained: ${rs(t.unexplainedPaise)}` : ''].filter(Boolean).join('; ')]),
      ],
    },
  ];
  downloadWorkbook(`GSTR9_${d.gstin ?? ''}_${d.fy}`, sheets);
}
