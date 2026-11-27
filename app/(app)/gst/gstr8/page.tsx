'use client';

// GSTR-8 — the return of an e-commerce operator that collects tax at source
// (CGST Act s.52, Rule 67).
//
// Each month the platform's settlement report gives, seller by seller, what
// was sold through it to registered and to unregistered buyers and what came
// back. Booked here, each record keeps back TCS on the net value (1% until 9
// July 2024, 0.5% from 10 July 2024) and the return is built from them: table
// 3 by seller GSTIN, table 4 the corrections to earlier filed months, 5 and 8
// the TCS paid over, 6 interest and late fee, then the tie-out to GST TCS
// Payable. Supplies on which the operator pays the GST itself under s.9(5)
// are booked alongside but are not in GSTR-8: they go to GSTR-3B 3.1.1(i).

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Download, FileJson, FileSpreadsheet, Info, Loader2, Plus, Printer } from 'lucide-react';
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
import { ReturnFilingBar } from '@/components/gst/return-filing';
import {
  ApiError, api, withholding, type EcoSupplyRow, type Gstr8AmendmentRow, type Gstr8Response,
} from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { useAppStore } from '@/lib/store';
import { GST_STATES } from '@/lib/tax/gst';
import { downloadWorkbook, type Sheet } from '@/lib/xlsx';
import { printPage } from '@/lib/output-guard';
import { cn } from '@/lib/utils';

const err = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
const rs = (p: number) => Math.round(p) / 100;
const states = Object.entries(GST_STATES).sort((a, b) => a[0].localeCompare(b[0]));
const SECTION: Record<'52' | '9_5', string> = { '52': 'TCS (section 52)', '9_5': 'Operator pays GST (section 9(5))' };

export default function Gstr8Page() {
  const [month, setMonth] = useState(localMonth());
  const state = useApi<Gstr8Response>(() => withholding.gstr8(month), [month]);
  const canCreate = usePermission('gst', 'create');
  const canEdit = usePermission('gst', 'edit');
  const canDelete = usePermission('gst', 'void');
  const del = useConfirmDelete();
  const [supply, setSupply] = useState<{ edit?: EcoSupplyRow } | null>(null);
  const [amend, setAmend] = useState<{ row: EcoSupplyRow | null; amendment?: Gstr8AmendmentRow } | null>(null);

  const downloadFile = async (d: Gstr8Response) => {
    try {
      downloadJson(`GSTR8_${d.role.gstin ?? 'GSTIN'}_${month.slice(5, 7)}${month.slice(0, 4)}.json`, await withholding.gstr8File(month));
      toast.success('GSTR-8 file downloaded', { description: 'On gst.gov.in: Returns → GSTR-8 → Prepare offline → Upload.' });
    } catch (e) {
      toast.error('Could not build the file', { description: err(e) });
    }
  };

  return (
    <>
      <PageHeader
        title="GSTR-8 — e-commerce TCS"
        description="Tax collected at source on supplies made through the platform (section 52), seller by seller, with the TCS paid."
        actions={
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="h-8 w-40" aria-label="Return period" data-slot="gstr8-month" />
            {state.data?.role.on && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1.5" data-slot="gstr8-export"><Download className="size-3.5" /> Export <ChevronDown className="size-3" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => state.data && void downloadFile(state.data)} data-slot="gstr8-export-json"><FileJson className="mr-2 size-3.5" /> Return file (JSON)</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => state.data && exportExcel(state.data)} data-slot="gstr8-export-excel"><FileSpreadsheet className="mr-2 size-3.5" /> Excel</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => printPage('GSTR-8')} data-slot="gstr8-print"><Printer className="mr-2 size-3.5" /> Print or save as PDF</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        }
      />
      <AsyncPage state={state}>
        {(d) => !d.role.on ? (
          <RoleOffCard slot="gstr8-role-off" title="This company is not set up as an e-commerce operator"
            what="GSTR-8 is filed by an e-commerce operator that collects payment for the supplies other sellers make through its platform. It keeps back TCS on their net taxable supplies under section 52 — 0.5% (0.25% CGST + 0.25% SGST, or 0.5% IGST) since 10 July 2024, 1% before — and reports it seller by seller."
            who="If the business runs such a platform, turn the role on and give its TCS registration. The month's supplies by seller, this return and the TCS paid then appear here, and GSTR-8 in the menu." />
        ) : (
          <>
            <Card className="grid gap-x-6 gap-y-3 p-4 text-sm sm:grid-cols-2 lg:grid-cols-5" data-slot="gstr8-header">
              <div><p className="micro-label">GSTIN of the operator</p><p className="mt-0.5 font-mono">{d.role.gstin ?? 'Not set'}</p></div>
              <div className="lg:col-span-2"><p className="micro-label">Legal name</p><p className="mt-0.5">{d.role.legalName}{d.role.tradeName && <span className="text-muted-foreground"> · {d.role.tradeName}</span>}</p></div>
              <div><p className="micro-label">Tax period</p><p className="mt-0.5">{d.period.label} · TCS {d.ratePct}%</p></div>
              <div>
                <p className="micro-label">Status</p>
                <div className="mt-0.5 flex flex-wrap items-center gap-2">
                  {d.filing ? <Badge className="bg-emerald-600 hover:bg-emerald-600">Filed</Badge> : localDay() > d.dueDate ? <Badge variant="destructive">Overdue</Badge> : <Badge variant="outline">Not filed</Badge>}
                  <span className="text-xs text-muted-foreground">Due {shortDate(d.dueDate)}</span>
                </div>
              </div>
            </Card>

            <ReturnFilingBar returnType="gstr8" period={month} title="GSTR-8" payableCashPaise={Math.max(0, d.table5.balance.igstPaise + d.table5.balance.cgstPaise + d.table5.balance.sgstPaise)} onChange={() => state.refetch()} />

            <div className="grid gap-3 sm:grid-cols-3">
              <Card className="p-4"><p className="micro-label">Net taxable supplies</p><Money value={d.totals.netPaise} className="mt-1 block text-2xl font-semibold" /><p className="text-xs text-muted-foreground">{d.totals.suppliers} seller(s)</p></Card>
              <Card className="p-4"><p className="micro-label">TCS collected</p><span data-slot="gstr8-total-tcs"><Money value={d.totals.taxPaise} className="mt-1 block text-2xl font-semibold" /></span><p className="text-xs text-muted-foreground">Table 3</p></Card>
              <Card className="p-4"><p className="micro-label">Still to pay over</p><Money value={d.table5.balance.igstPaise + d.table5.balance.cgstPaise + d.table5.balance.sgstPaise} className="mt-1 block text-2xl font-semibold" /><p className="text-xs text-muted-foreground">By {shortDate(d.dueDate)}</p></Card>
            </div>

            <TableCard slot="gstr8-supplies" title={`Supplies through the platform in ${d.period.label}`}
              hint="One record per seller from the month's settlement report. TCS posts Dr Accounts Payable (the seller) / Cr GST TCS Payable; a section 9(5) supply posts the operator's own output GST."
              actions={canCreate ? <Button size="sm" className="gap-1.5" onClick={() => setSupply({})} data-slot="gstr8-add"><Plus className="size-3.5" /> Add supplies</Button> : null}>
              <table className="w-full min-w-[1100px] text-sm">
                <thead><tr className="border-b">
                  <th className={cn(th, 'text-left')}>Seller</th><th className={cn(th, 'text-left')}>Kind</th>
                  <th className={cn(th, 'text-right')}>To registered</th><th className={cn(th, 'text-right')}>Returned</th>
                  <th className={cn(th, 'text-right')}>To unregistered</th><th className={cn(th, 'text-right')}>Returned</th>
                  <th className={cn(th, 'text-right')}>Net value</th><th className={cn(th, 'text-right')}>Tax</th><th className={th} />
                </tr></thead>
                <tbody>
                  {d.supplies.length === 0 ? (
                    <tr><td colSpan={9} className="px-4 py-6 text-sm text-muted-foreground" data-slot="gstr8-supplies-empty">Nothing booked for {d.period.label}. Use Add supplies for each seller in the month&apos;s settlement report.</td></tr>
                  ) : d.supplies.map((s) => (
                    <tr key={s.id} className="border-b last:border-0" data-slot="gstr8-supply">
                      <td className="px-3 py-2">{s.supplierName}<span className="block font-mono text-[11px] text-muted-foreground">{s.supplierGstin || 'Unregistered'} · {shortDate(s.date)}</span></td>
                      <td className="px-3 py-2 text-xs">{SECTION[s.section]}<span className="block text-muted-foreground">{s.ratePct}% · {s.inter ? 'IGST' : 'CGST + SGST'}</span>{s.amended && <Badge variant="outline" className="mt-0.5 text-[10px]">Amended later</Badge>}</td>
                      <td className={td}><Money value={s.grossRegisteredPaise} /></td>
                      <td className={td}><Money value={s.returnsRegisteredPaise} /></td>
                      <td className={td}><Money value={s.grossUnregisteredPaise} /></td>
                      <td className={td}><Money value={s.returnsUnregisteredPaise} /></td>
                      <td className={td}><Money value={s.netPaise} /></td>
                      <td className={td}><Money value={s.totalPaise} /></td>
                      <td className="px-3 py-2">
                        {d.filing && s.section === '52' ? (
                          canEdit && <div className="flex justify-end"><EditButton label="Amend" title="Report the correction in a later GSTR-8, table 4" onClick={() => setAmend({ row: s })} slot="gstr8-amend" /></div>
                        ) : (
                          <RowActions
                            onEdit={canEdit ? () => setSupply({ edit: s }) : null}
                            onDelete={canDelete ? () => del.ask({
                              title: 'Delete this record of supplies?', description: 'Its entry is reversed. The record is kept in the deleted documents.',
                              run: (reason) => withholding.deleteSupply(s.id, reason), done: 'Record deleted', onDone: () => state.refetch(),
                            }) : null} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableCard>

            <TableCard slot="gstr8-table3" title="3. Details of supplies made through the e-commerce operator" hint="One row per seller GSTIN: the gross value of supplies and what came back, to registered and to unregistered persons, the net amount liable for TCS, and the TCS by head.">
              <table className="w-full min-w-[1100px] text-sm">
                <thead><tr className="border-b">
                  <th className={cn(th, 'text-left')}>GSTIN of supplier</th>
                  <th className={cn(th, 'text-right')}>Supplies to registered</th><th className={cn(th, 'text-right')}>Returned</th>
                  <th className={cn(th, 'text-right')}>Supplies to unregistered</th><th className={cn(th, 'text-right')}>Returned</th>
                  <th className={cn(th, 'text-right')}>Net amount liable</th><th className={cn(th, 'text-right')}>Integrated tax</th><th className={cn(th, 'text-right')}>Central tax</th><th className={cn(th, 'text-right')}>State/UT tax</th>
                </tr></thead>
                <tbody>
                  {d.table3.length === 0 ? (
                    <tr><td colSpan={9} className="px-4 py-6 text-sm text-muted-foreground">No TCS collected in {d.period.label}.</td></tr>
                  ) : d.table3.map((t) => (
                    <tr key={t.gstin} className="border-b last:border-0" data-slot="gstr8-seller">
                      <td className="px-3 py-2"><span className="font-mono text-xs">{t.gstin}</span><span className="block text-[11px] text-muted-foreground">{t.name}</span></td>
                      <td className={td}><Money value={t.supRPaise} /></td><td className={td}><Money value={t.retsupRPaise} /></td>
                      <td className={td}><Money value={t.supUPaise} /></td><td className={td}><Money value={t.retsupUPaise} /></td>
                      <td className={td}><Money value={t.netPaise} /></td>
                      <td className={td}><Money value={t.igstPaise} /></td><td className={td}><Money value={t.cgstPaise} /></td><td className={td}><Money value={t.sgstPaise} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableCard>

            <TableCard slot="gstr8-table4" title="4. Amendments to details of supplies in respect of any earlier statement" hint="Records of an earlier, filed GSTR-8 corrected this month. The original month stays as filed; the difference in TCS is posted this month, at the rate of the original supplies.">
              <table className="w-full min-w-[1000px] text-sm">
                <thead><tr className="border-b">
                  <th className={cn(th, 'text-left')}>Original month</th><th className={cn(th, 'text-left')}>Original GSTIN</th><th className={cn(th, 'text-right')}>Original net</th>
                  <th className={cn(th, 'text-left')}>Revised GSTIN</th><th className={cn(th, 'text-right')}>Revised net</th><th className={cn(th, 'text-right')}>Revised TCS</th><th className={cn(th, 'text-right')}>Difference</th><th className={th} />
                </tr></thead>
                <tbody>
                  {d.table4.length === 0 ? (
                    <tr><td colSpan={8} className="px-4 py-6 text-sm text-muted-foreground">No amendments this month. To correct a record of a filed month, open that month and use Amend.</td></tr>
                  ) : d.table4.map((a) => (
                    <tr key={`${a.supplyId}-${a.date}`} className="border-b last:border-0" data-slot="gstr8-amendment">
                      <td className="px-3 py-2">{a.originalMonth}<span className="block text-[11px] text-muted-foreground">{a.supplierName}</span></td>
                      <td className="px-3 py-2 font-mono text-xs">{a.original.gstin}</td>
                      <td className={td}><Money value={a.original.valuePaise} /></td>
                      <td className="px-3 py-2 font-mono text-xs">{a.amended.gstin}</td>
                      <td className={td}><Money value={a.amended.valuePaise} /></td>
                      <td className={td}><Money value={a.amended.igstPaise + a.amended.cgstPaise + a.amended.sgstPaise} /></td>
                      <td className={cn(td, a.deltaPaise < 0 && 'text-destructive')}><Money value={a.deltaPaise} /></td>
                      <td className="px-3 py-2">{!d.filing && (
                        <RowActions
                          onEdit={canEdit ? () => setAmend({ row: null, amendment: a }) : null}
                          onDelete={canDelete ? () => del.ask({
                            title: 'Undo this amendment?', description: 'Its entries are reversed and the record goes back to the figures filed.',
                            confirmLabel: 'Undo amendment', run: (reason) => withholding.undoSupplyAmendment(a.supplyId, month, reason), done: 'Amendment undone', onDone: () => state.refetch(),
                          }) : null} />
                      )}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableCard>

            <PaymentCard slot="gstr8-table5" returnType="GSTR8" month={month} label="GSTR-8" payable={d.table5.payable} paid={d.table5.paid} balance={d.table5.balance}
              payment={d.payment} interest={d.table6} filed={!!d.filing} onDone={() => state.refetch()} />
            <InterestCard slot="gstr8-table6" interest={d.table6} />
            {d.section95.count > 0 && (
              <Card className="p-4 text-sm" data-slot="gstr8-section95">
                <p className="font-semibold">Supplies on which the operator pays the GST itself (section 9(5)) — not in GSTR-8</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {d.section95.count} record(s), net <Money value={d.section95.netPaise} />, GST <Money value={d.section95.igstPaise + d.section95.cgstPaise + d.section95.sgstPaise} /> on the output tax ledgers. Reported in GSTR-3B table 3.1.1(i) and GSTR-1 table 15.
                </p>
              </Card>
            )}
            <TieOutCard slot="gstr8-tieout" account="GST TCS Payable (2270)" month={d.period.label}
              ledgerPaise={d.tieOut.ledgerCollectedPaise} returnPaise={d.tieOut.returnCollectedPaise} differencePaise={d.tieOut.differencePaise}
              otherPaise={d.tieOut.otherPaise} paymentsPaise={d.tieOut.paymentsPaise} closingPaise={d.tieOut.closingBalancePaise} />
            {d.notes.length > 0 && (
              <Card className="space-y-1.5 p-4">
                {d.notes.map((n) => <p key={n} className="flex items-start gap-2 text-xs text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0 text-primary" /> {n}</p>)}
              </Card>
            )}
          </>
        )}
      </AsyncPage>
      {supply && state.data && (
        <SupplyDialog month={month} edit={supply.edit} stateCode={state.data.role.stateCode} onClose={() => setSupply(null)} onDone={() => { setSupply(null); state.refetch(); }} />
      )}
      {amend && (
        <AmendDialog month={month} row={amend.row} amendment={amend.amendment} onClose={() => setAmend(null)} onDone={() => { setAmend(null); state.refetch(); }} />
      )}
      {del.dialog}
    </>
  );
}

interface Preview { problem?: string | null; supplierName: string; supplierGstin: string; inter: boolean; netPaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; ratePct: number; totalPaise: number }

function SupplyDialog({ month, edit, stateCode, onClose, onDone }: { month: string; edit?: EcoSupplyRow; stateCode: string; onClose: () => void; onDone: () => void }) {
  const sellers = useAppStore((s) => s.contacts).filter((c) => c.kind === 'vendor' || c.kind === 'both');
  const lastDay = `${month}-${String(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()).padStart(2, '0')}`;
  const today = localDay();
  const [f, setF] = useState({
    supplierId: edit?.supplierId ?? '', section: (edit?.section ?? '52') as '52' | '9_5',
    entryDate: edit?.date ?? (today.slice(0, 7) === month ? today : lastDay), placeOfSupply: edit?.placeOfSupply ?? stateCode,
    grossRegisteredPaise: edit?.grossRegisteredPaise ?? 0, returnsRegisteredPaise: edit?.returnsRegisteredPaise ?? 0,
    grossUnregisteredPaise: edit?.grossUnregisteredPaise ?? 0, returnsUnregisteredPaise: edit?.returnsUnregisteredPaise ?? 0,
    gstRatePct: edit?.section === '9_5' ? edit.ratePct : 5, notes: edit?.notes ?? '',
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = JSON.stringify(f);
  useEffect(() => {
    if (!f.supplierId) return;
    const t = setTimeout(() => {
      api.get<Preview>('/api/gst/withholding', {
        view: 'eco-preview', supplierId: f.supplierId, section: f.section, pos: f.placeOfSupply, date: f.entryDate,
        supR: f.grossRegisteredPaise, retsupR: f.returnsRegisteredPaise, supU: f.grossUnregisteredPaise, retsupU: f.returnsUnregisteredPaise,
        gstRatePct: f.section === '9_5' ? f.gstRatePct : undefined,
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
      const b = { ...f, gstRatePct: f.section === '9_5' ? f.gstRatePct : null, notes: f.notes.trim() || null };
      if (edit) await withholding.updateSupply(edit.id, b);
      else await withholding.addSupply(b);
      toast.success(edit ? 'Record saved' : 'Supplies booked', { description: f.section === '52' ? 'TCS posted to GST TCS Payable.' : 'GST posted to the output tax ledgers.' });
      onDone();
    } catch (e) {
      setProblem(err(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl" data-slot="gstr8-supply-dialog">
        <DialogHeader>
          <DialogTitle>{edit ? 'Edit the supplies' : 'Add supplies through the platform'}</DialogTitle>
          <DialogDescription>One seller&apos;s supplies for the month, from the settlement report. Taxable value only, excluding GST.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Seller" required className="sm:col-span-2">
            <Select value={f.supplierId} onValueChange={(v) => setF({ ...f, supplierId: String(v) })}>
              <SelectTrigger data-slot="gstr8-supply-seller"><SelectValue placeholder="A vendor (with a GSTIN for TCS)" /></SelectTrigger>
              <SelectContent>{sellers.map((v) => <SelectItem key={v.id} value={v.id}>{v.displayName}{v.gstin ? ` · ${v.gstin}` : ' · unregistered'}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Kind of supply" required>
            <Select value={f.section} onValueChange={(v) => setF({ ...f, section: v as '52' | '9_5' })}>
              <SelectTrigger data-slot="gstr8-supply-section"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="52">{SECTION['52']}</SelectItem>
                <SelectItem value="9_5">{SECTION['9_5']}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Booked on" required><Input type="date" value={f.entryDate} onChange={(e) => setF({ ...f, entryDate: e.target.value })} data-slot="gstr8-supply-date" /></Field>
          <Field label="Place of supply" className="sm:col-span-2">
            <Select value={f.placeOfSupply} onValueChange={(v) => setF({ ...f, placeOfSupply: String(v) })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{states.map(([c, n]) => <SelectItem key={c} value={c}>{c} · {n}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Supplies to registered buyers"><MoneyInput valuePaise={f.grossRegisteredPaise} onChangePaise={(v) => setF({ ...f, grossRegisteredPaise: v })} /></Field>
          <Field label="Returned by registered buyers"><MoneyInput valuePaise={f.returnsRegisteredPaise} onChangePaise={(v) => setF({ ...f, returnsRegisteredPaise: v })} /></Field>
          <Field label="Supplies to unregistered buyers"><MoneyInput valuePaise={f.grossUnregisteredPaise} onChangePaise={(v) => setF({ ...f, grossUnregisteredPaise: v })} /></Field>
          <Field label="Returned by unregistered buyers"><MoneyInput valuePaise={f.returnsUnregisteredPaise} onChangePaise={(v) => setF({ ...f, returnsUnregisteredPaise: v })} /></Field>
          {f.section === '9_5' && (
            <Field label="GST rate of the supply, %" hint="5% for restaurant service through an app">
              <Input type="number" min={0} max={40} step="0.25" value={f.gstRatePct} onChange={(e) => setF({ ...f, gstRatePct: Number(e.target.value) })} />
            </Field>
          )}
          <Field label="Notes" className={f.section === '9_5' ? '' : 'sm:col-span-2'}><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={300} /></Field>
        </div>
        <div className="rounded-md border bg-muted/30 p-3 text-sm" data-slot="gstr8-preview" data-total={preview?.totalPaise ?? ''}>
          {preview ? (
            <>
              <p className="font-medium">{f.section === '52' ? 'TCS' : 'GST the operator pays'}: <Money value={preview.totalPaise} /> on net <Money value={preview.netPaise} /></p>
              <p className="text-xs text-muted-foreground">{preview.ratePct}% · {preview.inter ? <>IGST <Money value={preview.igstPaise} /></> : <>CGST <Money value={preview.cgstPaise} /> + SGST <Money value={preview.sgstPaise} /></>}</p>
            </>
          ) : <p className="text-xs text-muted-foreground">{problem ? '' : 'Pick the seller and enter the values to see the tax.'}</p>}
          {problem && <p className="text-xs text-destructive" data-slot="gstr8-supply-error">{problem}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !preview} data-slot="gstr8-supply-save">{busy && <Loader2 className="size-3.5 animate-spin" />} {edit ? 'Save' : 'Book and post'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AmendDialog({ month, row, amendment, onClose, onDone }: { month: string; row: EcoSupplyRow | null; amendment?: Gstr8AmendmentRow; onClose: () => void; onDone: () => void }) {
  const id = row?.id ?? amendment!.supplyId;
  const nextMonth = useMemo(() => {
    const [y, m] = month.split('-').map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }, [month]);
  const today = localDay();
  const a = amendment?.amended;
  const [f, setF] = useState({
    date: amendment?.date ?? (today.slice(0, 7) > month ? today : `${nextMonth}-01`),
    supplierGstin: a?.gstin ?? row?.supplierGstin ?? '',
    grossRegisteredPaise: a?.supR ?? row?.grossRegisteredPaise ?? 0, returnsRegisteredPaise: a?.retsupR ?? row?.returnsRegisteredPaise ?? 0,
    grossUnregisteredPaise: a?.supU ?? row?.grossUnregisteredPaise ?? 0, returnsUnregisteredPaise: a?.retsupU ?? row?.returnsUnregisteredPaise ?? 0,
    notes: '',
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await withholding.amendSupply(id, { ...f, supplierGstin: f.supplierGstin || null, notes: f.notes.trim() || null });
      toast.success('Amendment recorded', { description: `Reported in table 4 of GSTR-8 for ${f.date.slice(0, 7)}.` });
      onDone();
    } catch (e) {
      setProblem(err(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg" data-slot="gstr8-amend-dialog">
        <DialogHeader>
          <DialogTitle>Amend filed supplies</DialogTitle>
          <DialogDescription>The values as they should have been. The correction goes in table 4 of the return for the month you date it in, at the original TCS rate.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Date of the correction" required><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <Field label="Seller GSTIN"><Input value={f.supplierGstin} onChange={(e) => setF({ ...f, supplierGstin: e.target.value.toUpperCase().trim() })} className="font-mono" maxLength={15} /></Field>
          <Field label="Supplies to registered"><MoneyInput valuePaise={f.grossRegisteredPaise} onChangePaise={(v) => setF({ ...f, grossRegisteredPaise: v })} /></Field>
          <Field label="Returned (registered)"><MoneyInput valuePaise={f.returnsRegisteredPaise} onChangePaise={(v) => setF({ ...f, returnsRegisteredPaise: v })} /></Field>
          <Field label="Supplies to unregistered"><MoneyInput valuePaise={f.grossUnregisteredPaise} onChangePaise={(v) => setF({ ...f, grossUnregisteredPaise: v })} /></Field>
          <Field label="Returned (unregistered)"><MoneyInput valuePaise={f.returnsUnregisteredPaise} onChangePaise={(v) => setF({ ...f, returnsUnregisteredPaise: v })} /></Field>
          <Field label="Why" className="sm:col-span-2"><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={300} /></Field>
        </div>
        {problem && <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">{problem}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !f.date} data-slot="gstr8-amend-save">{busy && <Loader2 className="size-3.5 animate-spin" />} Record amendment</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function exportExcel(d: Gstr8Response) {
  const sheets: Sheet[] = [
    {
      name: 'Table 3', widths: [20, 30, 16, 14, 16, 14, 16, 12, 12, 12],
      rows: [
        ['GSTR-8', d.period.label], ['GSTIN of operator', d.role.gstin ?? ''], ['Legal name', d.role.legalName], ['TCS rate', `${d.ratePct}%`], [],
        ['GSTIN of supplier', 'Name', 'Supplies to registered', 'Returned', 'Supplies to unregistered', 'Returned', 'Net amount liable', 'IGST', 'CGST', 'SGST'],
        ...d.table3.map((t) => [t.gstin, t.name, rs(t.supRPaise), rs(t.retsupRPaise), rs(t.supUPaise), rs(t.retsupUPaise), rs(t.netPaise), rs(t.igstPaise), rs(t.cgstPaise), rs(t.sgstPaise)]),
      ],
    },
    {
      name: 'Records', widths: [12, 30, 18, 22, 14, 14, 14, 14, 14, 10, 12],
      rows: [
        ['Date', 'Seller', 'GSTIN', 'Kind', 'To registered', 'Returned', 'To unregistered', 'Returned', 'Net', 'Rate %', 'Tax'],
        ...d.supplies.map((s) => [s.date, s.supplierName, s.supplierGstin, SECTION[s.section], rs(s.grossRegisteredPaise), rs(s.returnsRegisteredPaise), rs(s.grossUnregisteredPaise), rs(s.returnsUnregisteredPaise), rs(s.netPaise), s.ratePct, rs(s.totalPaise)]),
      ],
    },
    {
      name: 'Table 4', widths: [12, 20, 14, 20, 14, 12, 12, 12],
      rows: [
        ['Original month', 'Original GSTIN', 'Original net', 'Revised GSTIN', 'Revised net', 'IGST', 'CGST', 'SGST'],
        ...d.table4.map((a) => [a.originalMonth, a.original.gstin, rs(a.original.valuePaise), a.amended.gstin, rs(a.amended.valuePaise), rs(a.amended.igstPaise), rs(a.amended.cgstPaise), rs(a.amended.sgstPaise)]),
      ],
    },
    {
      name: 'Tables 5 and 6', widths: [30, 14, 14, 14],
      rows: [
        ['Description', 'Integrated tax', 'Central tax', 'State/UT tax'],
        ['TCS payable', rs(d.table5.payable.igstPaise), rs(d.table5.payable.cgstPaise), rs(d.table5.payable.sgstPaise)],
        ['Paid in cash', rs(d.table5.paid.igstPaise), rs(d.table5.paid.cgstPaise), rs(d.table5.paid.sgstPaise)],
        ['Interest', rs(d.table6.interest.igstPaise), rs(d.table6.interest.cgstPaise), rs(d.table6.interest.sgstPaise)],
        ['Late fee', 0, rs(d.table6.lateFee.cgstPaise), rs(d.table6.lateFee.sgstPaise)],
      ],
    },
  ];
  downloadWorkbook(`GSTR8_${d.role.gstin ?? ''}_${d.period.month}`, sheets);
}
