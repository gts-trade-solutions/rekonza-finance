'use client';

// GSTR-3B — the monthly (or quarterly) summary return, and the one the tax is
// paid against.
//
// Laid out table by table as the GST portal shows it, in the portal's own
// words, so the figures can be read across line for line before filing. Every
// figure opens the invoices, bills and journals behind it. The return file
// downloads in the GSTN's JSON schema, and once filed the ARN is kept here.
//
// The set-off in table 6.1 follows the order the law fixes: IGST credit first,
// against IGST and then CGST and SGST; CGST and SGST credit only after that,
// never against each other (lib/server/gst/set-off.ts).

import { Fragment, useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, Download, FileJson, FileSpreadsheet, Info, Printer, RotateCcw, Undo2 } from 'lucide-react';
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
import { GstnReturnBar } from '@/components/gst/gstn-portal';
import { Money } from '@/components/shared/money';
import { AsyncPage } from '@/components/shared/async-state';
import { downloadCsv, downloadJson } from '@/components/shared/report-shell';
import { api, ApiError, gst, type Gstr3bDocRow, type Gstr3bFormResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { downloadWorkbook, type Sheet } from '@/lib/xlsx';
import { toRupees } from '@/lib/money';
import { GSTR3B_ROWS, GSTR3B_TABLES, stateLabel, type Gstr3bHeads, type Gstr3bRowKey } from '@/lib/gst/gstr3b-layout';

type Heads = 'IGST' | 'CGST' | 'SGST' | 'CESS';
const HEAD_LABEL: Record<Heads, string> = { IGST: 'Integrated Tax', CGST: 'Central Tax', SGST: 'State/UT Tax', CESS: 'Cess' };
const HEADS: Heads[] = ['IGST', 'CGST', 'SGST', 'CESS'];

const localMonth = () => {
  const d = new Date();
  // The return usually being prepared is last month's.
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const quarterOf = (month: string) => {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const fy = m >= 4 ? y : y - 1;
  const q = m >= 4 ? Math.floor((m - 4) / 3) + 1 : 4;
  return `${fy}-Q${q}`;
};
const longDay = (iso: string | null) =>
  iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

interface Drill { row: string; title: string; recipient?: string; pos?: string }

/** A figure on the form: opens the documents behind it. */
function Figure({ value, onOpen, muted }: { value: number; onOpen?: () => void; muted?: boolean }) {
  if (muted) return <span className="text-muted-foreground/50">—</span>;
  if (!onOpen || value === 0) return <Money value={value} />;
  return (
    <button type="button" onClick={onOpen} className="tabular text-primary underline-offset-2 hover:underline">
      <Money value={value} />
    </button>
  );
}

function TableCard({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <Card className="overflow-hidden p-0 print:break-inside-avoid">
      <div className="border-b bg-muted/40 px-4 py-2.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="overflow-x-auto thin-scroll">{children}</div>
    </Card>
  );
}

const th = 'px-3 py-2 text-right text-xs font-semibold text-muted-foreground';
const td = 'px-3 py-2 text-right';

export default function Gstr3bPage() {
  const calendar = useApi<{ profile: { frequency: 'monthly' | 'quarterly' } }>(() => api.get('/api/compliance-calendar'), []);
  const [mode, setMode] = useState<'monthly' | 'quarterly' | null>(null);
  const frequency = mode ?? calendar.data?.profile.frequency ?? 'monthly';
  const [month, setMonth] = useState(localMonth());
  const [quarter, setQuarter] = useState(quarterOf(localMonth()));
  const ret = frequency === 'quarterly' ? quarter : month;
  const state = useApi<Gstr3bFormResponse>(() => gst.gstr3bForm(ret), [ret]);
  const canFile = usePermission('gst', 'edit');
  const [drill, setDrill] = useState<Drill | null>(null);
  const [filing, setFiling] = useState(false);

  const quarters = useMemo(() => {
    const now = quarterOf(localMonth());
    const fy = Number(now.slice(0, 4));
    const out: { value: string; label: string }[] = [];
    for (let y = fy; y >= fy - 2; y--) {
      for (let q = 4; q >= 1; q--) {
        const key = `${y}-Q${q}`;
        if (key > now) continue;
        const names = ['Apr–Jun', 'Jul–Sep', 'Oct–Dec', 'Jan–Mar'][q - 1];
        out.push({ value: key, label: `Q${q} ${names} · FY ${y}-${String(y + 1).slice(2)}` });
      }
    }
    return out;
  }, []);

  const undoFiling = async () => {
    try {
      await api.post('/api/compliance-calendar', { action: 'undo', key: 'gstr3b', period: ret });
      toast.success('Marked as not filed');
      state.refetch();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not change the status');
    }
  };

  const downloadFile = async (d: Gstr3bFormResponse) => {
    try {
      const file = await gst.gstr3bFile(ret);
      downloadJson(`GSTR3B_${d.gstin ?? 'GSTIN'}_${ret}.json`, file);
      toast.success('Return file downloaded', { description: 'In the GSTN schema, ready for the portal or your GSP.' });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not build the return file');
    }
  };

  return (
    <>
      <PageHeader
        title="GSTR-3B"
        description="The summary return, table by table as the GST portal shows it. Click any figure to see the documents behind it."
        actions={
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <Select value={frequency} onValueChange={(v) => setMode(v as 'monthly' | 'quarterly')}>
              <SelectTrigger className="h-8 w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="quarterly">Quarterly</SelectItem>
              </SelectContent>
            </Select>
            {frequency === 'quarterly' ? (
              <Select value={quarter} onValueChange={setQuarter}>
                <SelectTrigger className="h-8 w-56"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {quarters.map((q) => <SelectItem key={q.value} value={q.value}>{q.label}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : (
              <Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="h-8 w-40" aria-label="Return period" />
            )}
            {state.data && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1.5"><Download className="size-3.5" /> Export <ChevronDown className="size-3" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => state.data && downloadFile(state.data)}><FileJson className="mr-2 size-3.5" /> Return file (JSON)</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => state.data && exportExcel(state.data)}><FileSpreadsheet className="mr-2 size-3.5" /> Excel</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => window.print()}><Printer className="mr-2 size-3.5" /> Print or save as PDF</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        }
      />

      <AsyncPage state={state}>
        {(d) => {
          const open = (row: Gstr3bRowKey) => () => setDrill({ row, title: `${GSTR3B_ROWS[row].table.replace(/^(\d)([A-D])$/, '$1($2)')} ${GSTR3B_ROWS[row].label}` });
          const r = d.rows;
          return (
            <>
              <Card className="grid gap-x-6 gap-y-3 p-4 text-sm sm:grid-cols-2 lg:grid-cols-5">
                <div><p className="micro-label">GSTIN</p><p className="mt-0.5 font-mono">{d.gstin ?? 'Not set'}</p></div>
                <div className="lg:col-span-2"><p className="micro-label">Legal name</p><p className="mt-0.5">{d.legalName}{d.tradeName ? <span className="text-muted-foreground"> · {d.tradeName}</span> : null}</p></div>
                <div><p className="micro-label">Return period</p><p className="mt-0.5">{d.period.label}</p></div>
                <div>
                  <p className="micro-label">Status</p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2">
                    {d.status.filed ? (
                      <Badge className="gap-1 bg-emerald-600 hover:bg-emerald-600"><CheckCircle2 className="size-3" /> Filed</Badge>
                    ) : d.status.overdue ? (
                      <Badge variant="destructive">Overdue</Badge>
                    ) : (
                      <Badge variant="outline">Not filed</Badge>
                    )}
                    <span className="text-xs text-muted-foreground">Due {longDay(d.status.dueDate)}</span>
                  </div>
                </div>
                {d.status.filed && (
                  <div className="sm:col-span-2 lg:col-span-5 flex flex-wrap items-center gap-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs">
                    <span>Filed on <b>{longDay(d.status.filedOn)}</b></span>
                    {d.status.arn && <span>ARN <span className="font-mono">{d.status.arn}</span></span>}
                    {d.status.filedBy && <span className="text-muted-foreground">marked by {d.status.filedBy}</span>}
                    {canFile && (
                      <Button variant="ghost" size="sm" className="ml-auto h-7 gap-1 print:hidden" onClick={undoFiling}><Undo2 className="size-3" /> Mark as not filed</Button>
                    )}
                  </div>
                )}
              </Card>

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Card className="p-4">
                  <p className="micro-label">Total tax liability</p>
                  <Money value={d.totals.liabilityPaise} className="mt-1 block text-2xl font-semibold" />
                  <p className="mt-0.5 text-xs text-muted-foreground">Including reverse charge</p>
                </Card>
                <Card className="p-4">
                  <p className="micro-label">Paid through ITC</p>
                  <Money value={d.totals.itcUsedPaise} className="mt-1 block text-2xl font-semibold" />
                  <p className="mt-0.5 text-xs text-muted-foreground">Net ITC available <Money value={d.itcNet.igstPaise + d.itcNet.cgstPaise + d.itcNet.sgstPaise + d.itcNet.cessPaise} /></p>
                </Card>
                <Card className={'p-4 ' + (d.totals.payablePaise > 0 ? 'border-amber-500/40 bg-amber-500/5' : 'border-emerald-500/40 bg-emerald-500/5')}>
                  <p className="micro-label">Payable in cash</p>
                  <Money value={d.totals.payablePaise} className="mt-1 block text-2xl font-semibold" />
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {d.totals.interestPaise + d.totals.lateFeePaise > 0
                      ? <>Tax <Money value={d.totals.cashPaise} /> + interest and late fee <Money value={d.totals.interestPaise + d.totals.lateFeePaise} /></>
                      : d.totals.cashPaise > 0 ? `By ${longDay(d.status.dueDate)}, through PMT-06 / the portal` : 'Fully covered by input credit'}
                  </p>
                </Card>
                <Card className="p-4">
                  <p className="micro-label">Credit carried forward</p>
                  <Money value={HEADS.reduce((t, h) => t + d.creditCarriedForward[h], 0)} className="mt-1 block text-2xl font-semibold" />
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {HEADS.filter((h) => d.creditCarriedForward[h] > 0).map((h) => `${h} ₹${toRupees(d.creditCarriedForward[h]).toLocaleString('en-IN')}`).join(' · ') || 'Nothing left over'}
                  </p>
                </Card>
              </div>

              <GstnReturnBar returnType="GSTR3B" period={ret} />

              {!d.status.filed && canFile && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-3 text-xs print:hidden">
                  <Info className="size-3.5 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1">
                    Filed on the GST portal yourself? Record the ARN here so the period is marked done on the compliance calendar. (Pushing and filing from the app, above, records it on its own.)
                  </span>
                  <Button size="sm" onClick={() => setFiling(true)}>Mark as filed</Button>
                </div>
              )}

              {/* 3.1 */}
              <TableCard title={GSTR3B_TABLES[0].title}>
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Nature of Supplies</th>
                      <th className={th}>Total Taxable value</th>
                      {HEADS.map((h) => <th key={h} className={th}>{HEAD_LABEL[h]}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {(['3.1a', '3.1b', '3.1c', '3.1d', '3.1e'] as const).map((k) => (
                      <FormRow key={k} k={k} v={r[k]} onOpen={open(k)} />
                    ))}
                  </tbody>
                </table>
              </TableCard>

              {/* 3.1.1 */}
              <TableCard title={GSTR3B_TABLES[1].title} hint="Supplies through an e-commerce operator who pays the tax under section 9(5) — restaurant, passenger transport and accommodation services through apps.">
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Nature of Supplies</th>
                      <th className={th}>Total Taxable value</th>
                      {HEADS.map((h) => <th key={h} className={th}>{HEAD_LABEL[h]}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {(['3.1.1i', '3.1.1ii'] as const).map((k) => <FormRow key={k} k={k} v={r[k]} onOpen={open(k)} />)}
                  </tbody>
                </table>
              </TableCard>

              {/* 3.2 */}
              <TableCard title={GSTR3B_TABLES[2].title}>
                <InterState d={d} onOpen={(recipient, pos) => setDrill({ row: '3.2', recipient, pos, title: `3.2 Inter-state supplies to ${recipient === 'uin' ? 'UIN holders' : recipient === 'composition' ? 'composition taxable persons' : 'unregistered persons'} · ${stateLabel(pos)}` })} />
              </TableCard>

              {/* 4 */}
              <TableCard title={GSTR3B_TABLES[3].title}>
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Details</th>
                      {HEADS.map((h) => <th key={h} className={th}>{HEAD_LABEL[h]}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    <GroupRow label="(A) ITC Available (whether in full or part)" v={d.itcAvailable} />
                    {(['4A1', '4A2', '4A3', '4A4', '4A5'] as const).map((k) => <TaxRow key={k} k={k} v={r[k]} onOpen={open(k)} />)}
                    <GroupRow label="(B) ITC Reversed" v={d.itcReversed} />
                    {(['4B1', '4B2'] as const).map((k) => <TaxRow key={k} k={k} v={r[k]} onOpen={open(k)} />)}
                    <GroupRow label="(C) Net ITC Available (A) - (B)" v={d.itcNet} strong />
                    <GroupRow label="(D) Other Details" />
                    {(['4D1', '4D2'] as const).map((k) => <TaxRow key={k} k={k} v={r[k]} onOpen={open(k)} />)}
                  </tbody>
                </table>
              </TableCard>

              {/* 5 */}
              <TableCard title={GSTR3B_TABLES[4].title}>
                <table className="w-full min-w-[520px] text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Nature of supplies</th>
                      <th className={th}>Inter-State supplies</th>
                      <th className={th}>Intra-State supplies</th>
                    </tr>
                  </thead>
                  <tbody>
                    {([['5gst', d.inward.gst], ['5nongst', d.inward.nonGst]] as const).map(([k, v]) => (
                      <tr key={k} className="border-b last:border-0">
                        <td className="px-3 py-2">{GSTR3B_ROWS[k].label}</td>
                        <td className={td}><Figure value={v.inter} onOpen={open(k)} /></td>
                        <td className={td}><Figure value={v.intra} onOpen={open(k)} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableCard>

              {/* 5.1 */}
              <TableCard title={GSTR3B_TABLES[5].title} hint={d.interestLateFee.basis}>
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Description</th>
                      {HEADS.map((h) => <th key={h} className={th}>{HEAD_LABEL[h]}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    <TaxValues label="Interest" v={d.interestLateFee.interest} />
                    <TaxValues label="Late Fees" v={d.interestLateFee.lateFee} />
                  </tbody>
                </table>
              </TableCard>

              {/* 6.1 */}
              <TableCard title={GSTR3B_TABLES[6].title} hint="Credit is used in the order Rule 88A fixes: IGST first, against IGST and then CGST and SGST where their own credit falls short; CGST and SGST credit never cross. Reverse-charge tax is always paid in cash.">
                <PaymentTable d={d} />
              </TableCard>

              {d.notes.length > 0 && (
                <Card className="space-y-1.5 p-4">
                  {d.notes.map((n) => (
                    <p key={n} className="flex items-start gap-2 text-xs text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0 text-primary" /> {n}</p>
                  ))}
                </Card>
              )}
            </>
          );
        }}
      </AsyncPage>

      {drill && <DrillDialog ret={ret} drill={drill} onClose={() => setDrill(null)} />}
      {filing && state.data && (
        <FileDialog
          ret={ret}
          dueDate={state.data.status.dueDate}
          onClose={() => setFiling(false)}
          onDone={() => { setFiling(false); state.refetch(); }}
        />
      )}
    </>
  );
}

function FormRow({ k, v, onOpen }: { k: Gstr3bRowKey; v: Gstr3bHeads; onOpen: () => void }) {
  const cols = GSTR3B_ROWS[k].columns;
  const shows = (h: Heads) => cols === 'all' || (cols === 'igst' && (h === 'IGST' || h === 'CESS'));
  const val = (h: Heads) => (h === 'IGST' ? v.igstPaise : h === 'CGST' ? v.cgstPaise : h === 'SGST' ? v.sgstPaise : v.cessPaise);
  return (
    <tr className="border-b last:border-0">
      <td className="px-3 py-2">{GSTR3B_ROWS[k].label}</td>
      <td className={td}><Figure value={v.taxablePaise} onOpen={onOpen} /></td>
      {HEADS.map((h) => <td key={h} className={td}><Figure value={val(h)} onOpen={onOpen} muted={!shows(h)} /></td>)}
    </tr>
  );
}

function TaxRow({ k, v, onOpen }: { k: Gstr3bRowKey; v: Gstr3bHeads; onOpen: () => void }) {
  return (
    <tr className="border-b last:border-0">
      <td className="py-2 pl-8 pr-3">{GSTR3B_ROWS[k].label}</td>
      <td className={td}><Figure value={v.igstPaise} onOpen={onOpen} /></td>
      <td className={td}><Figure value={v.cgstPaise} onOpen={onOpen} /></td>
      <td className={td}><Figure value={v.sgstPaise} onOpen={onOpen} /></td>
      <td className={td}><Figure value={v.cessPaise} onOpen={onOpen} /></td>
    </tr>
  );
}

function GroupRow({ label, v, strong }: { label: string; v?: Gstr3bHeads; strong?: boolean }) {
  return (
    <tr className={'border-b ' + (strong ? 'bg-muted/50 font-semibold' : 'bg-muted/25 font-medium')}>
      <td className="px-3 py-2">{label}</td>
      {v ? (
        <>
          <td className={td}><Money value={v.igstPaise} /></td>
          <td className={td}><Money value={v.cgstPaise} /></td>
          <td className={td}><Money value={v.sgstPaise} /></td>
          <td className={td}><Money value={v.cessPaise} /></td>
        </>
      ) : <td colSpan={4} />}
    </tr>
  );
}

function TaxValues({ label, v }: { label: string; v: Gstr3bHeads }) {
  return (
    <tr className="border-b last:border-0">
      <td className="px-3 py-2">{label}</td>
      <td className={td}><Money value={v.igstPaise} /></td>
      <td className={td}><Money value={v.cgstPaise} /></td>
      <td className={td}><Money value={v.sgstPaise} /></td>
      <td className={td}><Money value={v.cessPaise} /></td>
    </tr>
  );
}

function InterState({ d, onOpen }: { d: Gstr3bFormResponse; onOpen: (recipient: string, pos: string) => void }) {
  const states = [...new Set([...d.interState.unregistered, ...d.interState.composition, ...d.interState.uin].map((x) => x.pos))].sort();
  const cell = (who: 'unregistered' | 'composition' | 'uin', pos: string) => d.interState[who].find((x) => x.pos === pos);
  return (
    <table className="w-full min-w-[760px] text-sm">
      <thead>
        <tr className="border-b">
          <th rowSpan={2} className="px-3 py-2 text-left align-bottom text-xs font-semibold text-muted-foreground">Place of Supply (State/UT)</th>
          <th colSpan={2} className="border-l px-3 pt-2 text-center text-xs font-semibold text-muted-foreground">Supplies made to Unregistered Persons</th>
          <th colSpan={2} className="border-l px-3 pt-2 text-center text-xs font-semibold text-muted-foreground">Supplies made to Composition Taxable Persons</th>
          <th colSpan={2} className="border-l px-3 pt-2 text-center text-xs font-semibold text-muted-foreground">Supplies made to UIN holders</th>
        </tr>
        <tr className="border-b">
          {[0, 1, 2].map((i) => (
            <Fragment key={i}>
              <th className={th + ' border-l'}>Total Taxable value</th>
              <th className={th}>Amount of Integrated Tax</th>
            </Fragment>
          ))}
        </tr>
      </thead>
      <tbody>
        {states.length === 0 ? (
          <tr><td colSpan={7} className="px-3 py-3 text-sm text-muted-foreground">No inter-state supplies to unregistered persons, composition dealers or UIN holders in this period.</td></tr>
        ) : states.map((pos) => (
          <tr key={pos} className="border-b last:border-0">
            <td className="px-3 py-2">{stateLabel(pos)}</td>
            {(['unregistered', 'composition', 'uin'] as const).map((who) => {
              const c = cell(who, pos);
              return (
                <Fragment key={who}>
                  <td className={td + ' border-l'}><Figure value={c?.taxablePaise ?? 0} onOpen={() => onOpen(who, pos)} /></td>
                  <td className={td}><Figure value={c?.igstPaise ?? 0} onOpen={() => onOpen(who, pos)} /></td>
                </Fragment>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Which credit may meet which liability: never CGST and SGST across, cess only cess. */
function creditMayMeet(credit: Heads, liability: Heads) {
  if (credit === 'CESS' || liability === 'CESS') return credit === liability;
  return !((credit === 'CGST' && liability === 'SGST') || (credit === 'SGST' && liability === 'CGST'));
}

function PaymentTable({ d }: { d: Gstr3bFormResponse }) {
  const group = (kind: 'forward' | 'rcm') => d.payment.filter((p) => p.kind === kind);
  return (
    <table className="w-full min-w-[980px] text-sm">
      <thead>
        <tr className="border-b">
          <th rowSpan={2} className="px-3 py-2 text-left align-bottom text-xs font-semibold text-muted-foreground">Description</th>
          <th rowSpan={2} className={th + ' align-bottom'}>Tax payable</th>
          <th colSpan={4} className="border-l px-3 pt-2 text-center text-xs font-semibold text-muted-foreground">Paid through ITC</th>
          <th rowSpan={2} className={th + ' border-l align-bottom'}>Tax paid in cash</th>
          <th rowSpan={2} className={th + ' align-bottom'}>Interest paid in cash</th>
          <th rowSpan={2} className={th + ' align-bottom'}>Late Fee paid in cash</th>
        </tr>
        <tr className="border-b">
          {HEADS.map((h, i) => <th key={h} className={th + (i === 0 ? ' border-l' : '')}>{HEAD_LABEL[h]}</th>)}
        </tr>
      </thead>
      <tbody>
        {([['forward', '(A) Other than reverse charge'], ['rcm', '(B) Reverse charge']] as const).map(([kind, label]) => (
          <Fragment key={kind}>
            <tr className="border-b bg-muted/25"><td colSpan={9} className="px-3 py-2 font-medium">{label}</td></tr>
            {group(kind).map((p) => (
              <tr key={`${kind}-${p.head}`} className="border-b last:border-0">
                <td className="py-2 pl-8 pr-3">{HEAD_LABEL[p.head]}</td>
                <td className={td}><Money value={p.payablePaise} /></td>
                {HEADS.map((h, i) => {
                  // Credit of a head that the law does not let meet this liability.
                  const barred = kind === 'rcm' || !creditMayMeet(h, p.head);
                  return (
                    <td key={h} className={td + (i === 0 ? ' border-l' : '')}>
                      {barred ? <span className="text-muted-foreground/50">—</span> : <Money value={p.itc[h]} />}
                    </td>
                  );
                })}
                <td className={td + ' border-l font-medium'}><Money value={p.cashPaise} /></td>
                <td className={td}>{kind === 'rcm' ? <span className="text-muted-foreground/50">—</span> : <Money value={p.interestPaise} />}</td>
                <td className={td}>{kind === 'rcm' || p.head === 'IGST' || p.head === 'CESS' ? <span className="text-muted-foreground/50">—</span> : <Money value={p.lateFeePaise} />}</td>
              </tr>
            ))}
          </Fragment>
        ))}
        <tr className="border-t-2 bg-muted/40 font-semibold">
          <td className="px-3 py-2.5">Total</td>
          <td className={td}><Money value={d.payment.reduce((t, p) => t + p.payablePaise, 0)} /></td>
          {HEADS.map((h, i) => <td key={h} className={td + (i === 0 ? ' border-l' : '')}><Money value={d.payment.reduce((t, p) => t + p.itc[h], 0)} /></td>)}
          <td className={td + ' border-l'}><Money value={d.totals.cashPaise} /></td>
          <td className={td}><Money value={d.totals.interestPaise} /></td>
          <td className={td}><Money value={d.totals.lateFeePaise} /></td>
        </tr>
      </tbody>
    </table>
  );
}

function DrillDialog({ ret, drill, onClose }: { ret: string; drill: Drill; onClose: () => void }) {
  const state = useApi(() => gst.gstr3bDocs(ret, drill.row, { recipient: drill.recipient, pos: drill.pos }), [ret, drill.row, drill.recipient, drill.pos]);
  const docs = state.data?.documents ?? [];
  const total = (k: keyof Gstr3bHeads) => docs.reduce((t, x) => t + x[k], 0);
  const exportCsv = () => downloadCsv(`gstr3b-${drill.row}-${ret}.csv`, [
    ['Date', 'Document', 'Party', 'GSTIN', 'Place of supply', 'Taxable value', 'IGST', 'CGST', 'SGST', 'Cess', 'Note'],
    ...docs.map((x: Gstr3bDocRow) => [x.date, x.number, x.party ?? '', x.gstin ?? '', x.pos ? stateLabel(x.pos) : '', toRupees(x.taxablePaise), toRupees(x.igstPaise), toRupees(x.cgstPaise), toRupees(x.sgstPaise), toRupees(x.cessPaise), x.note ?? '']),
  ]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="pr-6 text-base">{drill.title}</DialogTitle>
          <DialogDescription>{state.data ? `${docs.length} document${docs.length === 1 ? '' : 's'} make up this figure.` : 'Loading the documents…'}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto thin-scroll rounded-md border">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="sticky top-0 bg-muted">
              <tr className="border-b text-xs text-muted-foreground">
                <th className="px-3 py-2 text-left font-semibold">Date</th>
                <th className="px-3 py-2 text-left font-semibold">Document</th>
                <th className="px-3 py-2 text-left font-semibold">Party</th>
                <th className="px-3 py-2 text-left font-semibold">Place of supply</th>
                <th className="px-3 py-2 text-right font-semibold">Taxable value</th>
                <th className="px-3 py-2 text-right font-semibold">IGST</th>
                <th className="px-3 py-2 text-right font-semibold">CGST</th>
                <th className="px-3 py-2 text-right font-semibold">SGST</th>
                <th className="px-3 py-2 text-right font-semibold">Cess</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((x, i) => (
                <tr key={`${x.docType}-${x.docId ?? x.number}-${i}`} className="border-b last:border-0 hover:bg-accent/40">
                  <td className="whitespace-nowrap px-3 py-2">{longDay(x.date)}</td>
                  <td className="px-3 py-2">
                    {x.href ? <a href={x.href} className="text-primary hover:underline">{x.number}</a> : x.number}
                    <span className="ml-1.5 text-[11px] text-muted-foreground">{x.docType.replace(/_/g, ' ')}</span>
                    {x.note && <span className="block text-[11px] text-muted-foreground">{x.note}</span>}
                  </td>
                  <td className="px-3 py-2">{x.party ?? '—'}{x.gstin && <span className="block font-mono text-[11px] text-muted-foreground">{x.gstin}</span>}</td>
                  <td className="px-3 py-2 text-xs">{x.pos ? stateLabel(x.pos) : '—'}</td>
                  <td className="px-3 py-2 text-right"><Money value={x.taxablePaise} /></td>
                  <td className="px-3 py-2 text-right"><Money value={x.igstPaise} /></td>
                  <td className="px-3 py-2 text-right"><Money value={x.cgstPaise} /></td>
                  <td className="px-3 py-2 text-right"><Money value={x.sgstPaise} /></td>
                  <td className="px-3 py-2 text-right"><Money value={x.cessPaise} /></td>
                </tr>
              ))}
              {state.data && docs.length === 0 && (
                <tr><td colSpan={9} className="px-3 py-4 text-center text-muted-foreground">Nothing in this period.</td></tr>
              )}
            </tbody>
            {docs.length > 1 && (
              <tfoot>
                <tr className="border-t-2 bg-muted/40 font-semibold">
                  <td className="px-3 py-2" colSpan={4}>Total</td>
                  <td className="px-3 py-2 text-right"><Money value={total('taxablePaise')} /></td>
                  <td className="px-3 py-2 text-right"><Money value={total('igstPaise')} /></td>
                  <td className="px-3 py-2 text-right"><Money value={total('cgstPaise')} /></td>
                  <td className="px-3 py-2 text-right"><Money value={total('sgstPaise')} /></td>
                  <td className="px-3 py-2 text-right"><Money value={total('cessPaise')} /></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!docs.length} className="gap-1.5"><Download className="size-3.5" /> Export</Button>
          <Button size="sm" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FileDialog({ ret, dueDate, onClose, onDone }: { ret: string; dueDate: string; onClose: () => void; onDone: () => void }) {
  const today = new Date();
  const [doneOn, setDoneOn] = useState(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`);
  const [arn, setArn] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/api/compliance-calendar', { action: 'done', key: 'gstr3b', period: ret, doneOn, reference: arn.trim() || null });
      toast.success('GSTR-3B marked as filed', { description: 'The compliance calendar shows it done.' });
      onDone();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Mark GSTR-3B as filed</DialogTitle>
          <DialogDescription>Record the date it was filed and the ARN the portal gave. Due {longDay(dueDate)}.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="filed-on">Date of filing</Label>
            <Input id="filed-on" type="date" value={doneOn} onChange={(e) => setDoneOn(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="arn">ARN</Label>
            <Input id="arn" value={arn} onChange={(e) => setArn(e.target.value.toUpperCase())} placeholder="AA3310260123456" maxLength={20} className="font-mono" />
            <p className="text-xs text-muted-foreground">The acknowledgement reference number shown after filing.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}><RotateCcw className="mr-1.5 size-3.5" /> Cancel</Button>
          <Button onClick={save} disabled={busy || !doneOn}>{busy ? 'Saving…' : 'Mark as filed'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The form as a workbook, laid out table by table like the screen. */
function exportExcel(d: Gstr3bFormResponse) {
  const rs = (p: number) => toRupees(p);
  const rows: (string | number)[][] = [
    ['GSTR-3B', d.period.label],
    ['GSTIN', d.gstin ?? ''],
    ['Legal name', d.legalName],
    ['Status', d.status.filed ? `Filed on ${d.status.filedOn}${d.status.arn ? `, ARN ${d.status.arn}` : ''}` : `Not filed (due ${d.status.dueDate})`],
    [],
    [GSTR3B_TABLES[0].title],
    ['Nature of Supplies', 'Total Taxable value', 'Integrated Tax', 'Central Tax', 'State/UT Tax', 'Cess'],
    ...(['3.1a', '3.1b', '3.1c', '3.1d', '3.1e'] as const).map((k) => [GSTR3B_ROWS[k].label, rs(d.rows[k].taxablePaise), rs(d.rows[k].igstPaise), rs(d.rows[k].cgstPaise), rs(d.rows[k].sgstPaise), rs(d.rows[k].cessPaise)]),
    [],
    [GSTR3B_TABLES[1].title],
    ...(['3.1.1i', '3.1.1ii'] as const).map((k) => [GSTR3B_ROWS[k].label, rs(d.rows[k].taxablePaise), rs(d.rows[k].igstPaise), rs(d.rows[k].cgstPaise), rs(d.rows[k].sgstPaise), rs(d.rows[k].cessPaise)]),
    [],
    [GSTR3B_TABLES[2].title],
    ['Place of supply', 'Recipient', 'Total Taxable value', 'Integrated Tax'],
    ...(['unregistered', 'composition', 'uin'] as const).flatMap((w) => d.interState[w].map((x) => [stateLabel(x.pos), w, rs(x.taxablePaise), rs(x.igstPaise)])),
    [],
    [GSTR3B_TABLES[3].title],
    ['Details', 'Integrated Tax', 'Central Tax', 'State/UT Tax', 'Cess'],
    ['(A) ITC Available', rs(d.itcAvailable.igstPaise), rs(d.itcAvailable.cgstPaise), rs(d.itcAvailable.sgstPaise), rs(d.itcAvailable.cessPaise)],
    ...(['4A1', '4A2', '4A3', '4A4', '4A5'] as const).map((k) => [`  ${GSTR3B_ROWS[k].label}`, rs(d.rows[k].igstPaise), rs(d.rows[k].cgstPaise), rs(d.rows[k].sgstPaise), rs(d.rows[k].cessPaise)]),
    ['(B) ITC Reversed', rs(d.itcReversed.igstPaise), rs(d.itcReversed.cgstPaise), rs(d.itcReversed.sgstPaise), rs(d.itcReversed.cessPaise)],
    ...(['4B1', '4B2'] as const).map((k) => [`  ${GSTR3B_ROWS[k].label}`, rs(d.rows[k].igstPaise), rs(d.rows[k].cgstPaise), rs(d.rows[k].sgstPaise), rs(d.rows[k].cessPaise)]),
    ['(C) Net ITC Available (A) - (B)', rs(d.itcNet.igstPaise), rs(d.itcNet.cgstPaise), rs(d.itcNet.sgstPaise), rs(d.itcNet.cessPaise)],
    ['(D) Other Details'],
    ...(['4D1', '4D2'] as const).map((k) => [`  ${GSTR3B_ROWS[k].label}`, rs(d.rows[k].igstPaise), rs(d.rows[k].cgstPaise), rs(d.rows[k].sgstPaise), rs(d.rows[k].cessPaise)]),
    [],
    [GSTR3B_TABLES[4].title],
    ['Nature of supplies', 'Inter-State supplies', 'Intra-State supplies'],
    [GSTR3B_ROWS['5gst'].label, rs(d.inward.gst.inter), rs(d.inward.gst.intra)],
    [GSTR3B_ROWS['5nongst'].label, rs(d.inward.nonGst.inter), rs(d.inward.nonGst.intra)],
    [],
    [GSTR3B_TABLES[5].title],
    ['Description', 'Integrated Tax', 'Central Tax', 'State/UT Tax', 'Cess'],
    ['Interest', rs(d.interestLateFee.interest.igstPaise), rs(d.interestLateFee.interest.cgstPaise), rs(d.interestLateFee.interest.sgstPaise), rs(d.interestLateFee.interest.cessPaise)],
    ['Late Fees', 0, rs(d.interestLateFee.lateFee.cgstPaise), rs(d.interestLateFee.lateFee.sgstPaise), 0],
    [],
    [GSTR3B_TABLES[6].title],
    ['Description', 'Tax payable', 'ITC: Integrated', 'ITC: Central', 'ITC: State/UT', 'ITC: Cess', 'Tax paid in cash', 'Interest paid in cash', 'Late fee paid in cash'],
    ...d.payment.map((p) => [`${p.kind === 'rcm' ? '(B) Reverse charge' : '(A) Other than reverse charge'} · ${HEAD_LABEL[p.head]}`, rs(p.payablePaise), rs(p.itc.IGST), rs(p.itc.CGST), rs(p.itc.SGST), rs(p.itc.CESS), rs(p.cashPaise), rs(p.interestPaise), rs(p.lateFeePaise)]),
  ];
  const sheet: Sheet = { name: 'GSTR-3B', rows, widths: [70, 18, 16, 16, 16, 14, 16, 16, 16] };
  downloadWorkbook(`GSTR3B_${d.gstin ?? ''}_${d.period.key}`, [sheet]);
}
