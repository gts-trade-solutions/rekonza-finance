'use client';

// GSTR-7 — the return of a GST TDS deductor (CGST Act s.51, Rule 66).
//
// The screen runs in the order the work is done: the bills that need TDS
// deducted (registered suppliers, contracts above ₹2.5 lakh), the deductions
// made this month, the return's tables built from them — 3 deductee by
// deductee, 4 the corrections to earlier filed months, 5 and 8 the tax paid
// over, 6 interest and late fee — and the tie-out to GST TDS Payable. Each
// deductee's GSTR-7A certificate opens from its row in table 3.

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Download, FileJson, FileSpreadsheet, Info, Loader2, Plus, Printer, ScrollText } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage } from '@/components/shared/async-state';
import { Money } from '@/components/shared/money';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { EditButton, RowActions, useConfirmDelete } from '@/components/shared/row-actions';
import { downloadJson } from '@/components/shared/report-shell';
import {
  InterestCard, PaymentCard, RoleOffCard, TableCard, TieOutCard, localDay, localMonth, shortDate, td, th,
} from '@/components/gst/withholding-parts';
// FILING-BAR import { ReturnFilingBar } from '@/components/gst/return-filing';
import {
  ApiError, withholding, type Gstr7AmendmentRow, type Gstr7DeductionRow, type Gstr7Response, type PendingTdsBillRow, type TdsPreview,
} from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { useAppStore } from '@/lib/store';
import { GST_STATES } from '@/lib/tax/gst';
import { downloadWorkbook, type Sheet } from '@/lib/xlsx';
import { printPage } from '@/lib/output-guard';
import { cn } from '@/lib/utils';

// FILING-BAR stub, until the shared filing bar lands.
function ReturnFilingBarStub(_: { returnType: string; period: string; title: string; payableCashPaise?: number; onChange?: () => void }) { void _; return null; }
const err = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
const rs = (p: number) => Math.round(p) / 100;
const states = Object.entries(GST_STATES).sort((a, b) => a[0].localeCompare(b[0]));

export default function Gstr7Page() {
  const [month, setMonth] = useState(localMonth());
  const state = useApi<Gstr7Response>(() => withholding.gstr7(month), [month]);
  const canCreate = usePermission('gst', 'create');
  const canEdit = usePermission('gst', 'edit');
  const canDelete = usePermission('gst', 'void');
  const del = useConfirmDelete();
  const [deduct, setDeduct] = useState<{ bill?: PendingTdsBillRow; edit?: Gstr7DeductionRow } | null>(null);
  const [amend, setAmend] = useState<{ row: Gstr7DeductionRow | null; amendment?: Gstr7AmendmentRow } | null>(null);

  const downloadFile = async (d: Gstr7Response) => {
    try {
      downloadJson(`GSTR7_${d.role.gstin ?? 'GSTIN'}_${month.slice(5, 7)}${month.slice(0, 4)}.json`, await withholding.gstr7File(month));
      toast.success('GSTR-7 file downloaded', { description: 'On gst.gov.in: Returns → GSTR-7 → Prepare offline → Upload.' });
    } catch (e) {
      toast.error('Could not build the file', { description: err(e) });
    }
  };

  return (
    <>
      <PageHeader
        title="GSTR-7 — GST TDS"
        description="Tax deducted at source from payments to suppliers (section 51), deductee by deductee, with the tax paid and the GSTR-7A certificates."
        actions={
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="h-8 w-40" aria-label="Return period" data-slot="gstr7-month" />
            {state.data?.role.on && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1.5" data-slot="gstr7-export"><Download className="size-3.5" /> Export <ChevronDown className="size-3" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => state.data && void downloadFile(state.data)} data-slot="gstr7-export-json"><FileJson className="mr-2 size-3.5" /> Return file (JSON)</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => state.data && exportExcel(state.data)} data-slot="gstr7-export-excel"><FileSpreadsheet className="mr-2 size-3.5" /> Excel</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => printPage('GSTR-7')} data-slot="gstr7-print"><Printer className="mr-2 size-3.5" /> Print or save as PDF</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        }
      />
      <AsyncPage state={state}>
        {(d) => !d.role.on ? (
          <RoleOffCard slot="gstr7-role-off" title="This company is not set up as a GST TDS deductor"
            what="GSTR-7 is filed by those who must deduct GST at source under section 51: departments of the Central or a State Government, local authorities, government agencies, and the bodies notified under it (bodies set up by an Act, government societies and public sector undertakings). They deduct 2% — 1% CGST + 1% SGST, or 2% IGST — from payments to registered suppliers under contracts worth more than ₹2.5 lakh."
            who="If the business is such a deductor, turn the role on and give its GST TDS registration. The deductions, this return and the GSTR-7A certificates then appear here, and GSTR-7 in the menu." />
        ) : (
          <>
            <Card className="grid gap-x-6 gap-y-3 p-4 text-sm sm:grid-cols-2 lg:grid-cols-5" data-slot="gstr7-header">
              <div><p className="micro-label">GSTIN of the deductor</p><p className="mt-0.5 font-mono">{d.role.gstin ?? 'Not set'}</p></div>
              <div className="lg:col-span-2"><p className="micro-label">Legal name</p><p className="mt-0.5">{d.role.legalName}{d.role.tradeName && <span className="text-muted-foreground"> · {d.role.tradeName}</span>}</p></div>
              <div><p className="micro-label">Tax period</p><p className="mt-0.5">{d.period.label}</p></div>
              <div>
                <p className="micro-label">Status</p>
                <div className="mt-0.5 flex flex-wrap items-center gap-2">
                  {d.filing ? <Badge className="bg-emerald-600 hover:bg-emerald-600">Filed</Badge> : localDay() > d.dueDate ? <Badge variant="destructive">Overdue</Badge> : <Badge variant="outline">Not filed</Badge>}
                  <span className="text-xs text-muted-foreground">Due {shortDate(d.dueDate)}</span>
                </div>
              </div>
            </Card>

            {/* FILING-BAR */}{false && <ReturnFilingBarStub returnType="gstr7" period={month} title="GSTR-7" payableCashPaise={Math.max(0, d.table5.balance.igstPaise + d.table5.balance.cgstPaise + d.table5.balance.sgstPaise)} onChange={() => state.refetch()} />}

            <div className="grid gap-3 sm:grid-cols-3">
              <Card className="p-4"><p className="micro-label">Amount paid to deductees</p><Money value={d.totals.taxablePaise} className="mt-1 block text-2xl font-semibold" /><p className="text-xs text-muted-foreground">{d.totals.deductees} deductee(s)</p></Card>
              <Card className="p-4"><p className="micro-label">TDS deducted</p><span data-slot="gstr7-total-tds"><Money value={d.totals.taxPaise} className="mt-1 block text-2xl font-semibold" /></span><p className="text-xs text-muted-foreground">Table 3</p></Card>
              <Card className="p-4"><p className="micro-label">Still to pay over</p><Money value={d.table5.balance.igstPaise + d.table5.balance.cgstPaise + d.table5.balance.sgstPaise} className="mt-1 block text-2xl font-semibold" /><p className="text-xs text-muted-foreground">By {shortDate(d.dueDate)}</p></Card>
            </div>

            <TableCard slot="gstr7-pending" title="Bills that need GST TDS"
              hint="Bills from registered suppliers worth more than ₹2.5 lakh before tax, with nothing deducted yet. Deduct when you pay or credit the supplier; the bill is settled by the TDS."
              actions={canCreate ? <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setDeduct({})} data-slot="gstr7-deduct-other"><Plus className="size-3.5" /> Deduct without a bill</Button> : null}>
              {d.pending.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted-foreground" data-slot="gstr7-pending-empty">
                  No bill is waiting. A bill shows here once it is from a supplier with a GSTIN and is above ₹2.5 lakh before tax —{' '}
                  <Link href="/purchases/bills/new" className="text-primary hover:underline">record a bill</Link>, or deduct against a contract payment without one.
                </p>
              ) : (
                <table className="w-full min-w-[900px] text-sm">
                  <thead><tr className="border-b">
                    <th className={cn(th, 'text-left')}>Bill</th><th className={cn(th, 'text-left')}>Supplier</th><th className={cn(th, 'text-left')}>GSTIN</th>
                    <th className={cn(th, 'text-right')}>Taxable value</th><th className={cn(th, 'text-right')}>Balance due</th><th className={cn(th, 'text-right')}>TDS to deduct</th><th className={th} />
                  </tr></thead>
                  <tbody>
                    {d.pending.map((b) => (
                      <tr key={b.billId} className="border-b last:border-0" data-slot="gstr7-pending-row">
                        <td className="px-3 py-2"><Link href={`/purchases/bills/${b.billId}`} className="text-primary hover:underline">{b.billNo}</Link><span className="block text-[11px] text-muted-foreground">{b.vendorInvoiceNo} · {shortDate(b.billDate)}</span></td>
                        <td className="px-3 py-2">{b.vendorName}</td>
                        <td className="px-3 py-2 font-mono text-xs">{b.gstin}</td>
                        <td className={td}><Money value={b.taxablePaise} /></td>
                        <td className={td}><Money value={b.outstandingPaise} /></td>
                        <td className={td}>{b.preview.applies ? <Money value={b.preview.totalPaise} /> : <span className="text-xs text-muted-foreground" title={b.preview.reason}>Not deducted</span>}</td>
                        <td className="px-3 py-2 text-right">{canCreate && <Button size="sm" className="h-7" onClick={() => setDeduct({ bill: b })} data-slot="gstr7-deduct">Deduct GST TDS</Button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </TableCard>

            <TableCard slot="gstr7-table3" title="3. Details of the tax deducted at source" hint="One row per deductee, as the portal takes it. The amount is what was paid or credited to them, excluding GST.">
              <table className="w-full min-w-[900px] text-sm">
                <thead><tr className="border-b">
                  <th className={cn(th, 'text-left')}>GSTIN of deductee</th><th className={cn(th, 'text-left')}>Name</th>
                  <th className={cn(th, 'text-right')}>Amount paid</th><th className={cn(th, 'text-right')}>Integrated tax</th><th className={cn(th, 'text-right')}>Central tax</th>
                  <th className={cn(th, 'text-right')}>State/UT tax</th><th className={th} />
                </tr></thead>
                <tbody>
                  {d.table3.length === 0 ? (
                    <tr><td colSpan={7} className="px-4 py-6 text-sm text-muted-foreground">No tax deducted in {d.period.label}. Deduct it from a bill above, and it is reported here.</td></tr>
                  ) : d.table3.map((t) => (
                    <tr key={t.gstin} className="border-b last:border-0" data-slot="gstr7-deductee">
                      <td className="px-3 py-2 font-mono text-xs">{t.gstin}</td>
                      <td className="px-3 py-2">{t.name}{t.count > 1 && <span className="text-xs text-muted-foreground"> · {t.count} deductions</span>}</td>
                      <td className={td}><Money value={t.taxablePaise} /></td>
                      <td className={td}><Money value={t.igstPaise} /></td>
                      <td className={td}><Money value={t.cgstPaise} /></td>
                      <td className={td}><Money value={t.sgstPaise} /></td>
                      <td className="px-3 py-2 text-right">
                        <Button asChild size="sm" variant="outline" className="h-7 gap-1"><Link href={`/gst/gstr7/certificate?period=${month}&gstin=${t.gstin}`} data-slot="gstr7-certificate"><ScrollText className="size-3.5" /> Certificate (GSTR-7A)</Link></Button>
                      </td>
                    </tr>
                  ))}
                  {d.table3.length > 0 && (
                    <tr className="border-t-2 bg-muted/40 font-semibold">
                      <td className="px-3 py-2" colSpan={2}>Total</td>
                      <td className={td}><Money value={d.totals.taxablePaise} /></td>
                      <td className={td}><Money value={d.table3.reduce((s, t) => s + t.igstPaise, 0)} /></td>
                      <td className={td}><Money value={d.table3.reduce((s, t) => s + t.cgstPaise, 0)} /></td>
                      <td className={td}><Money value={d.table3.reduce((s, t) => s + t.sgstPaise, 0)} /></td>
                      <td />
                    </tr>
                  )}
                </tbody>
              </table>
            </TableCard>

            <TableCard slot="gstr7-deductions" title={`Deductions made in ${d.period.label}`} hint={d.filing ? 'The month is filed: a deduction found wrong is corrected with Amend, reported in table 4 of a later GSTR-7.' : 'Each deduction posts Dr Accounts Payable (the supplier) / Cr GST TDS Payable.'}>
              <table className="w-full min-w-[1000px] text-sm">
                <thead><tr className="border-b">
                  <th className={cn(th, 'text-left')}>Date</th><th className={cn(th, 'text-left')}>Supplier</th><th className={cn(th, 'text-left')}>Bill / contract</th>
                  <th className={cn(th, 'text-right')}>Contract value</th><th className={cn(th, 'text-right')}>Amount paid</th><th className={cn(th, 'text-right')}>TDS</th><th className={th} />
                </tr></thead>
                <tbody>
                  {d.deductions.length === 0 ? (
                    <tr><td colSpan={7} className="px-4 py-6 text-sm text-muted-foreground">None this month.</td></tr>
                  ) : d.deductions.map((x) => (
                    <tr key={x.id} className="border-b last:border-0" data-slot="gstr7-deduction">
                      <td className="whitespace-nowrap px-3 py-2">{shortDate(x.date)}</td>
                      <td className="px-3 py-2">{x.vendorName}<span className="block font-mono text-[11px] text-muted-foreground">{x.deducteeGstin}</span></td>
                      <td className="px-3 py-2">{x.billId ? <Link href={`/purchases/bills/${x.billId}`} className="text-primary hover:underline">{x.billNo}</Link> : <span className="text-muted-foreground">No bill</span>}
                        {x.contractRef && <span className="block text-[11px] text-muted-foreground">Contract {x.contractRef}</span>}
                        {x.amended && <Badge variant="outline" className="ml-1 text-[10px]">Amended later</Badge>}</td>
                      <td className={td}><Money value={x.contractValuePaise} /></td>
                      <td className={td}><Money value={x.taxablePaise} /></td>
                      <td className={td}><Money value={x.totalPaise} /><span className="block text-[11px] text-muted-foreground">{x.igstPaise ? 'IGST 2%' : 'CGST 1% + SGST 1%'}</span></td>
                      <td className="px-3 py-2">
                        {d.filing ? (
                          canEdit && <div className="flex justify-end"><EditButton label="Amend" title="Report the correction in a later GSTR-7, table 4" onClick={() => setAmend({ row: x })} slot="gstr7-amend" /></div>
                        ) : (
                          <RowActions
                            onEdit={canEdit ? () => setDeduct({ edit: x }) : null}
                            onDelete={canDelete ? () => del.ask({
                              title: 'Delete this deduction?',
                              description: `Its entry is reversed and ${x.billNo ? `bill ${x.billNo} is owed in full again` : 'the supplier is owed the amount again'}. The record is kept in the deleted documents.`,
                              run: (reason) => withholding.deleteDeduction(x.id, reason), done: 'Deduction deleted', onDone: () => state.refetch(),
                            }) : null} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableCard>

            <TableCard slot="gstr7-table4" title="4. Amendments to details of tax deducted in earlier tax periods" hint="Deductions reported in an earlier, filed GSTR-7 and corrected this month. The original month stays as filed; the difference in tax is posted this month.">
              <table className="w-full min-w-[1000px] text-sm">
                <thead><tr className="border-b">
                  <th className={cn(th, 'text-left')}>Original month</th><th className={cn(th, 'text-left')}>Original GSTIN</th><th className={cn(th, 'text-right')}>Original amount</th>
                  <th className={cn(th, 'text-left')}>Revised GSTIN</th><th className={cn(th, 'text-right')}>Revised amount</th><th className={cn(th, 'text-right')}>Revised tax</th><th className={cn(th, 'text-right')}>Difference</th><th className={th} />
                </tr></thead>
                <tbody>
                  {d.table4.length === 0 ? (
                    <tr><td colSpan={8} className="px-4 py-6 text-sm text-muted-foreground">No amendments this month. To correct a deduction of a filed month, open that month and use Amend.</td></tr>
                  ) : d.table4.map((a) => (
                    <tr key={`${a.deductionId}-${a.date}`} className="border-b last:border-0" data-slot="gstr7-amendment">
                      <td className="px-3 py-2">{a.originalMonth}<span className="block text-[11px] text-muted-foreground">{a.vendorName}</span></td>
                      <td className="px-3 py-2 font-mono text-xs">{a.originalGstin}</td>
                      <td className={td}><Money value={a.originalTaxablePaise} /></td>
                      <td className="px-3 py-2 font-mono text-xs">{a.gstin}</td>
                      <td className={td}><Money value={a.taxablePaise} /></td>
                      <td className={td}><Money value={a.igstPaise + a.cgstPaise + a.sgstPaise} /></td>
                      <td className={cn(td, a.deltaPaise < 0 && 'text-destructive')}><Money value={a.deltaPaise} /></td>
                      <td className="px-3 py-2">{!d.filing && (
                        <RowActions
                          onEdit={canEdit ? () => setAmend({ row: null, amendment: a }) : null}
                          onDelete={canDelete ? () => del.ask({
                            title: 'Undo this amendment?', description: 'Its entries are reversed and the deduction goes back to the figures filed.',
                            confirmLabel: 'Undo amendment', run: (reason) => withholding.undoDeductionAmendment(a.deductionId, month, reason), done: 'Amendment undone', onDone: () => state.refetch(),
                          }) : null} />
                      )}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableCard>

            <PaymentCard slot="gstr7-table5" returnType="GSTR7" month={month} label="GSTR-7" payable={d.table5.payable} paid={d.table5.paid} balance={d.table5.balance}
              payment={d.payment} interest={d.table6} filed={!!d.filing} onDone={() => state.refetch()} />
            <InterestCard slot="gstr7-table6" interest={d.table6} />
            <Card className="p-4 text-sm" data-slot="gstr7-table7">
              <p className="font-semibold">7. Refund claimed from the electronic cash ledger</p>
              <p className="mt-1 text-xs text-muted-foreground">Nothing is claimed from here. An excess in the cash ledger is claimed on the portal (Services → Refunds → Application for refund, RFD-01) and shows in this table there.</p>
            </Card>
            <TieOutCard slot="gstr7-tieout" account="GST TDS Payable (2260)" month={d.period.label}
              ledgerPaise={d.tieOut.ledgerWithheldPaise} returnPaise={d.tieOut.returnWithheldPaise} differencePaise={d.tieOut.differencePaise}
              otherPaise={d.tieOut.otherPaise} paymentsPaise={d.tieOut.paymentsPaise} closingPaise={d.tieOut.closingBalancePaise} />
            {d.notes.length > 0 && (
              <Card className="space-y-1.5 p-4">
                {d.notes.map((n) => <p key={n} className="flex items-start gap-2 text-xs text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0 text-primary" /> {n}</p>)}
              </Card>
            )}
          </>
        )}
      </AsyncPage>
      {deduct && state.data && (
        <DeductDialog month={month} bill={deduct.bill} edit={deduct.edit} stateCode={state.data.role.stateCode}
          onClose={() => setDeduct(null)} onDone={() => { setDeduct(null); state.refetch(); }} />
      )}
      {amend && (
        <AmendDialog month={month} row={amend.row} amendment={amend.amendment} onClose={() => setAmend(null)} onDone={() => { setAmend(null); state.refetch(); }} />
      )}
      {del.dialog}
    </>
  );
}

/** Deduct GST TDS: from a waiting bill, without one, or a deduction being corrected. The figures show before anything posts. */
function DeductDialog({ month, bill, edit, stateCode, onClose, onDone }: {
  month: string; bill?: PendingTdsBillRow; edit?: Gstr7DeductionRow; stateCode: string; onClose: () => void; onDone: () => void;
}) {
  const vendors = useAppStore((s) => s.contacts).filter((c) => (c.kind === 'vendor' || c.kind === 'both') && c.gstin);
  const today = localDay();
  const defaultDate = today.slice(0, 7) === month ? today : `${month}-${String(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()).padStart(2, '0')}`;
  const [f, setF] = useState({
    vendorId: edit?.vendorId ?? bill?.vendorId ?? '',
    billId: edit?.billId ?? bill?.billId ?? null,
    deductionDate: edit?.date ?? defaultDate,
    contractRef: edit?.contractRef ?? '',
    contractValuePaise: edit?.contractValuePaise ?? bill?.taxablePaise ?? 0,
    taxablePaise: edit?.taxablePaise ?? bill?.taxablePaise ?? 0,
    placeOfSupply: bill?.placeOfSupply ?? stateCode,
    notes: edit?.notes ?? '',
  });
  const [preview, setPreview] = useState<TdsPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = JSON.stringify([f.vendorId, f.billId, f.deductionDate, f.contractValuePaise, f.taxablePaise, f.placeOfSupply]);
  useEffect(() => {
    if (!f.vendorId && !f.billId) return;
    if (!f.taxablePaise) { setPreview(null); return; }
    const t = setTimeout(() => {
      withholding.tdsPreview({
        billId: f.billId ?? undefined, vendorId: f.billId ? undefined : f.vendorId || undefined, date: f.deductionDate,
        contractValuePaise: f.contractValuePaise || undefined, taxablePaise: f.taxablePaise || undefined, pos: f.placeOfSupply,
      }).then((p) => {
        if (p.problem) { setPreview(null); setProblem(p.problem); } else { setPreview(p); setProblem(null); }
      }).catch((e) => { setPreview(null); setProblem(err(e)); });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const save = async () => {
    setBusy(true);
    try {
      const b = {
        billId: f.billId, vendorId: f.billId ? null : f.vendorId || null, deductionDate: f.deductionDate,
        contractRef: f.contractRef.trim() || null, contractValuePaise: f.contractValuePaise || null, taxablePaise: f.taxablePaise || null,
        placeOfSupply: f.placeOfSupply, notes: f.notes.trim() || null,
      };
      if (edit) await withholding.updateDeduction(edit.id, b);
      else await withholding.deduct(b);
      toast.success(edit ? 'Deduction saved' : 'GST TDS deducted', { description: 'Posted to GST TDS Payable; the supplier is owed the rest.' });
      onDone();
    } catch (e) {
      setProblem(err(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl" data-slot="gstr7-deduct-dialog">
        <DialogHeader>
          <DialogTitle>{edit ? 'Edit the deduction' : 'Deduct GST TDS'}</DialogTitle>
          <DialogDescription>
            {bill ? <>From {bill.vendorName}, on bill {bill.billNo} ({bill.vendorInvoiceNo}).</> : edit ? <>From {edit.vendorName}.</> : 'From a payment under a contract, without a bill.'}{' '}
            2% of what is paid or credited, excluding GST, where the contract is worth more than ₹2.5 lakh.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {!bill && !edit?.billId && (
            <Field label="Supplier (registered)" required className="sm:col-span-2">
              <Select value={f.vendorId} onValueChange={(v) => setF({ ...f, vendorId: String(v) })} disabled={!!edit}>
                <SelectTrigger data-slot="gstr7-deduct-vendor"><SelectValue placeholder="A vendor with a GSTIN" /></SelectTrigger>
                <SelectContent>{vendors.map((v) => <SelectItem key={v.id} value={v.id}>{v.displayName} · {v.gstin}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          )}
          <Field label="Date deducted" required hint="The day it was paid or credited"><Input type="date" value={f.deductionDate} onChange={(e) => setF({ ...f, deductionDate: e.target.value })} data-slot="gstr7-deduct-date" /></Field>
          <Field label="Contract reference"><Input value={f.contractRef} onChange={(e) => setF({ ...f, contractRef: e.target.value })} placeholder="Work order no." maxLength={100} data-slot="gstr7-contract-ref" /></Field>
          <Field label="Contract value, excluding GST" hint="Decides whether section 51 applies"><MoneyInput valuePaise={f.contractValuePaise} onChangePaise={(v) => setF({ ...f, contractValuePaise: v })} /></Field>
          <Field label="Amount paid or credited, excluding GST" required><MoneyInput valuePaise={f.taxablePaise} onChangePaise={(v) => setF({ ...f, taxablePaise: v })} /></Field>
          <Field label="Place of supply" className="sm:col-span-2">
            <Select value={f.placeOfSupply} onValueChange={(v) => setF({ ...f, placeOfSupply: String(v) })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{states.map(([c, n]) => <SelectItem key={c} value={c}>{c} · {n}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Notes" className="sm:col-span-2"><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={300} /></Field>
        </div>
        <div className="rounded-md border bg-muted/30 p-3 text-sm" data-slot="gstr7-preview" data-total={preview?.totalPaise ?? ''}>
          {preview ? (
            <div className="space-y-1">
              <p className="font-medium">TDS to deduct: <Money value={preview.totalPaise} /></p>
              <p className="text-xs text-muted-foreground">
                {preview.inter ? <>IGST <Money value={preview.igstPaise} /></> : <>CGST <Money value={preview.cgstPaise} /> + SGST <Money value={preview.sgstPaise} /></>} · {preview.reason}
              </p>
              {preview.billOutstandingPaise != null && <p className="text-xs text-muted-foreground">The bill then owes <Money value={preview.billOutstandingPaise - preview.totalPaise + (edit?.totalPaise ?? 0)} /> to the supplier.</p>}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{problem ? '' : 'Pick the supplier and the amount to see the TDS.'}</p>
          )}
          {problem && <p className="text-xs text-destructive" data-slot="gstr7-deduct-error">{problem}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !preview} data-slot="gstr7-deduct-save">{busy && <Loader2 className="size-3.5 animate-spin" />} {edit ? 'Save' : 'Deduct and post'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Amend a deduction of a filed month, in a later month's table 4. */
function AmendDialog({ month, row, amendment, onClose, onDone }: {
  month: string; row: Gstr7DeductionRow | null; amendment?: Gstr7AmendmentRow; onClose: () => void; onDone: () => void;
}) {
  const id = row?.id ?? amendment!.deductionId;
  const nextMonth = useMemo(() => {
    const [y, m] = month.split('-').map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }, [month]);
  const today = localDay();
  const [f, setF] = useState({
    date: amendment?.date ?? (today.slice(0, 7) > month ? today : `${nextMonth}-01`),
    deducteeGstin: amendment?.gstin ?? row?.deducteeGstin ?? '',
    taxablePaise: amendment?.taxablePaise ?? row?.taxablePaise ?? 0,
    notes: '',
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await withholding.amendDeduction(id, { date: f.date, deducteeGstin: f.deducteeGstin || null, taxablePaise: f.taxablePaise, notes: f.notes.trim() || null });
      toast.success('Amendment recorded', { description: `Reported in table 4 of GSTR-7 for ${f.date.slice(0, 7)}.` });
      onDone();
    } catch (e) {
      setProblem(err(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg" data-slot="gstr7-amend-dialog">
        <DialogHeader>
          <DialogTitle>Amend a filed deduction</DialogTitle>
          <DialogDescription>
            {row ? <>Filed in {month}: {row.vendorName}, <Money value={row.taxablePaise} /> paid, TDS <Money value={row.totalPaise} />.</> : <>Originally filed in {amendment!.originalMonth}.</>}{' '}
            The correction goes in table 4 of the return for the month you date it in.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Date of the correction" required><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <Field label="Deductee GSTIN"><Input value={f.deducteeGstin} onChange={(e) => setF({ ...f, deducteeGstin: e.target.value.toUpperCase().trim() })} className="font-mono" maxLength={15} /></Field>
          <Field label="Amount paid, excluding GST" hint="Nil if nothing should have been deducted" className="sm:col-span-2"><MoneyInput valuePaise={f.taxablePaise} onChangePaise={(v) => setF({ ...f, taxablePaise: v })} /></Field>
          <Field label="Why" className="sm:col-span-2"><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="GSTIN keyed wrong; amount short" maxLength={300} /></Field>
        </div>
        {problem && <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">{problem}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !f.date} data-slot="gstr7-amend-save">{busy && <Loader2 className="size-3.5 animate-spin" />} Record amendment</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The return as a workbook: each table on its own sheet, in rupees. */
function exportExcel(d: Gstr7Response) {
  const sheets: Sheet[] = [
    {
      name: 'Table 3', widths: [20, 36, 16, 14, 14, 14],
      rows: [
        ['GSTR-7', d.period.label], ['GSTIN of deductor', d.role.gstin ?? ''], ['Legal name', d.role.legalName], [],
        ['GSTIN of deductee', 'Name', 'Amount paid', 'Integrated tax', 'Central tax', 'State/UT tax'],
        ...d.table3.map((t) => [t.gstin, t.name, rs(t.taxablePaise), rs(t.igstPaise), rs(t.cgstPaise), rs(t.sgstPaise)]),
      ],
    },
    {
      name: 'Deductions', widths: [12, 30, 18, 16, 18, 16, 16, 12, 12, 12],
      rows: [
        ['Date', 'Supplier', 'GSTIN', 'Bill', 'Contract', 'Contract value', 'Amount paid', 'IGST', 'CGST', 'SGST'],
        ...d.deductions.map((x) => [x.date, x.vendorName, x.deducteeGstin, x.billNo ?? '', x.contractRef ?? '', rs(x.contractValuePaise), rs(x.taxablePaise), rs(x.igstPaise), rs(x.cgstPaise), rs(x.sgstPaise)]),
      ],
    },
    {
      name: 'Table 4', widths: [12, 20, 16, 20, 16, 12, 12, 12],
      rows: [
        ['Original month', 'Original GSTIN', 'Original amount', 'Revised GSTIN', 'Revised amount', 'IGST', 'CGST', 'SGST'],
        ...d.table4.map((a) => [a.originalMonth, a.originalGstin, rs(a.originalTaxablePaise), a.gstin, rs(a.taxablePaise), rs(a.igstPaise), rs(a.cgstPaise), rs(a.sgstPaise)]),
      ],
    },
    {
      name: 'Tables 5 and 6', widths: [30, 14, 14, 14],
      rows: [
        ['Description', 'Integrated tax', 'Central tax', 'State/UT tax'],
        ['TDS payable', rs(d.table5.payable.igstPaise), rs(d.table5.payable.cgstPaise), rs(d.table5.payable.sgstPaise)],
        ['Paid in cash', rs(d.table5.paid.igstPaise), rs(d.table5.paid.cgstPaise), rs(d.table5.paid.sgstPaise)],
        ['Interest', rs(d.table6.interest.igstPaise), rs(d.table6.interest.cgstPaise), rs(d.table6.interest.sgstPaise)],
        ['Late fee', 0, rs(d.table6.lateFee.cgstPaise), rs(d.table6.lateFee.sgstPaise)],
      ],
    },
  ];
  downloadWorkbook(`GSTR7_${d.role.gstin ?? ''}_${d.period.month}`, sheets);
}
