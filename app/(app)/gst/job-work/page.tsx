'use client';

// Job work: goods out with job workers on job-work challans, receiving them
// back, and ITC-04. What is not back within a year is, in law, supplied on the
// day it went.

import { useState } from 'react';
import { AlertTriangle, Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import { Money } from '@/components/shared/money';
import { ReportTable } from '@/components/shared/report-shell';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { today } from '@/lib/selectors';
import { downloadWorkbook } from '@/lib/xlsx';

interface Line {
  challanId: string; number: string; date: string; status: string; worker: string; gstin: string | null; stateCode: string | null;
  lineId: string; itemId: string | null; description: string | null; hsnSac: string | null; uqc: string | null;
  sent: number; received: number; waste: number; outstanding: number; valuePaise: number; dueBack: string;
}
interface Itc04 {
  from: string; to: string; sent: Line[]; overdue: Line[];
  received: { receivedDate: string; jobWorkerChallanNo: string | null; jobWorkerChallanDate: string | null; natureOfJob: string | null; challanNumber: string; challanDate: string; worker: string; gstin: string | null; description: string | null; uqc: string | null; qtyReceived: number; qtyWaste: number }[];
}

const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const fmt = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const fyNow = () => (Number(today().slice(5, 7)) >= 4 ? Number(today().slice(0, 4)) : Number(today().slice(0, 4)) - 1);

export default function JobWorkPage() {
  return (
    <>
      <PageHeader title="Job work" description="Goods with job workers, coming back, and the ITC-04 return. Send goods on a delivery challan of type job work." />
      <Tabs defaultValue="out">
        <TabsList><TabsTrigger value="out">With job workers</TabsTrigger><TabsTrigger value="itc04">ITC-04</TabsTrigger></TabsList>
        <TabsContent value="out" className="mt-4"><Outstanding /></TabsContent>
        <TabsContent value="itc04" className="mt-4"><Return /></TabsContent>
      </Tabs>
    </>
  );
}

function Outstanding() {
  const state = useApi<{ lines: Line[] }>(() => api.get('/api/job-work'), []);
  const canEdit = usePermission('gst', 'edit');
  const [receiving, setReceiving] = useState<string | null>(null);
  return (
    <AsyncPage state={state} loading={<LoadingRows rows={6} />}>
      {(d) => {
        const open = d.lines.filter((l) => l.outstanding > 0);
        const challans = [...new Set(open.map((l) => l.challanId))];
        return (
          <div className="space-y-3">
            {challans.length === 0 && <Card className="p-6 text-center text-sm text-muted-foreground">Nothing is out with a job worker.</Card>}
            {challans.map((id) => {
              const ls = open.filter((l) => l.challanId === id);
              const late = ls[0].dueBack <= today();
              return (
                <Card key={id} className="gap-0 overflow-hidden p-0">
                  <div className="flex flex-wrap items-center gap-3 border-b px-4 py-2.5">
                    <p className="text-sm font-semibold">{ls[0].number}</p>
                    <span className="text-xs text-muted-foreground">{ls[0].worker} · sent {fmt(ls[0].date)}</span>
                    {late
                      ? <Badge variant="outline" className="border-red-500/40 text-[10px] text-red-700 dark:text-red-300">Over a year: supplied in law</Badge>
                      : <span className="text-xs text-muted-foreground">back by {fmt(ls[0].dueBack)}</span>}
                    {canEdit && <Button size="sm" variant="outline" className="ml-auto" onClick={() => setReceiving(id)}>Record goods back</Button>}
                  </div>
                  <ReportTable>
                    <thead><tr className="border-b"><th className={`${th} text-left`}>Goods</th><th className={`${th} text-right`}>Sent</th><th className={`${th} text-right`}>Back</th><th className={`${th} text-right`}>Waste</th><th className={`${th} text-right`}>Still out</th></tr></thead>
                    <tbody className="divide-y">
                      {ls.map((l) => (
                        <tr key={l.lineId}>
                          <td className="px-3 py-2">{l.description}</td><td className="px-3 py-2 text-right">{l.sent} {l.uqc}</td>
                          <td className="px-3 py-2 text-right">{l.received}</td><td className="px-3 py-2 text-right">{l.waste}</td>
                          <td className="px-3 py-2 text-right font-medium">{l.outstanding}</td>
                        </tr>
                      ))}
                    </tbody>
                  </ReportTable>
                </Card>
              );
            })}
            <ReceiveDialog lines={receiving ? open.filter((l) => l.challanId === receiving) : []} onClose={() => setReceiving(null)}
              onDone={() => { setReceiving(null); void state.refetch(); }} />
          </div>
        );
      }}
    </AsyncPage>
  );
}

function ReceiveDialog({ lines, onClose, onDone }: { lines: Line[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ date: today(), challanNo: '', challanDate: '', nature: '' });
  const [qty, setQty] = useState<Record<string, { back: string; waste: string }>>({});
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/api/job-work', {
        challanId: lines[0].challanId, date: f.date, jobWorkerChallanNo: f.challanNo || null, jobWorkerChallanDate: f.challanDate || null,
        natureOfJob: f.nature || null,
        lines: lines.map((l) => ({ challanLineId: l.lineId, qtyReceived: Number(qty[l.lineId]?.back) || 0, qtyWaste: Number(qty[l.lineId]?.waste) || 0 })),
      });
      toast.success('Goods back recorded');
      setQty({});
      onDone();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={lines.length > 0} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Goods back on {lines[0]?.number}</DialogTitle>
          <DialogDescription>What came back, and what was lost or wasted in the process. Waste leaves stock.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Received on"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <Field label="Nature of job work"><Input value={f.nature} onChange={(e) => setF({ ...f, nature: e.target.value })} placeholder="Laser cutting" /></Field>
          <Field label="Job worker's challan"><Input value={f.challanNo} onChange={(e) => setF({ ...f, challanNo: e.target.value })} /></Field>
          <Field label="Its date"><Input type="date" value={f.challanDate} onChange={(e) => setF({ ...f, challanDate: e.target.value })} /></Field>
        </div>
        <div className="space-y-2">
          {lines.map((l) => (
            <div key={l.lineId} className="flex items-center gap-2 text-sm">
              <span className="flex-1">{l.description} <span className="text-xs text-muted-foreground">({l.outstanding} out)</span></span>
              <Input type="number" min={0} step="any" placeholder="Back" className="w-24" value={qty[l.lineId]?.back ?? ''} onChange={(e) => setQty({ ...qty, [l.lineId]: { back: e.target.value, waste: qty[l.lineId]?.waste ?? '' } })} />
              <Input type="number" min={0} step="any" placeholder="Waste" className="w-24" value={qty[l.lineId]?.waste ?? ''} onChange={(e) => setQty({ ...qty, [l.lineId]: { back: qty[l.lineId]?.back ?? '', waste: e.target.value } })} />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy} className="gap-1.5" onClick={() => void save()}>{busy && <Loader2 className="size-3.5 animate-spin" />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Return() {
  const [period, setPeriod] = useState(`${fyNow()}-H1`);
  const fy = Number(period.slice(0, 4));
  const [from, to] = period.endsWith('H1') ? [`${fy}-04-01`, `${fy}-09-30`] : period.endsWith('H2') ? [`${fy}-10-01`, `${fy + 1}-03-31`] : [`${fy}-04-01`, `${fy + 1}-03-31`];
  const state = useApi<Itc04>(() => api.get('/api/job-work', { from, to }), [from, to]);
  const options = [0, 1].flatMap((i) => {
    const y = fyNow() - i;
    const label = `FY ${y}-${String((y + 1) % 100).padStart(2, '0')}`;
    return [{ v: `${y}-H1`, l: `${label}, April–September` }, { v: `${y}-H2`, l: `${label}, October–March` }, { v: `${y}-FY`, l: `${label}, whole year` }];
  });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={period} onValueChange={(v) => setPeriod(String(v))}>
          <SelectTrigger className="w-72"><SelectValue /></SelectTrigger>
          <SelectContent>{options.map((o) => <SelectItem key={o.v} value={o.v}>{o.l}</SelectItem>)}</SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">Half-yearly above ₹5 crore turnover, yearly otherwise.</span>
        {state.data && (
          <Button size="sm" variant="outline" className="ml-auto gap-1.5" onClick={() => downloadWorkbook(`ITC-04-${from}-${to}.xlsx`, [
            { name: '4 Sent to job workers', rows: [['GSTIN', 'State', 'Job worker', 'Challan', 'Date', 'Description', 'HSN', 'UQC', 'Quantity', 'Taxable value'],
              ...state.data!.sent.map((l) => [l.gstin ?? '', l.stateCode ?? '', l.worker, l.number, l.date, l.description ?? '', l.hsnSac ?? '', l.uqc ?? '', l.sent, l.valuePaise / 100])] },
            { name: '5A Received back', rows: [['GSTIN', 'Job worker', 'Original challan', 'Date', "Job worker's challan", 'Date', 'Nature of job', 'Description', 'UQC', 'Quantity', 'Losses and waste'],
              ...state.data!.received.map((r) => [r.gstin ?? '', r.worker, r.challanNumber, r.challanDate, r.jobWorkerChallanNo ?? '', r.jobWorkerChallanDate ?? '', r.natureOfJob ?? '', r.description ?? '', r.uqc ?? '', r.qtyReceived, r.qtyWaste])] },
          ])}><Download className="size-3.5" /> Excel</Button>
        )}
      </div>
      <AsyncPage state={state} loading={<LoadingRows rows={5} />}>
        {(d) => (
          <>
            {d.overdue.length > 0 && (
              <Card className="flex items-start gap-3 border-red-500/40 bg-red-500/5 p-4 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-600" />
                <p>{d.overdue.length} line(s) have been with a job worker for over a year. Section 143 treats them as supplied on the day they were sent: raise an invoice and pay the tax with interest.</p>
              </Card>
            )}
            <Card className="gap-0 overflow-hidden p-0">
              <div className="border-b px-4 py-2.5 text-sm font-semibold">Table 4 · sent to job workers ({d.sent.length})</div>
              {d.sent.length === 0 ? <p className="p-4 text-sm text-muted-foreground">None.</p> : (
                <ReportTable>
                  <thead><tr className="border-b"><th className={`${th} text-left`}>Challan</th><th className={`${th} text-left`}>Job worker</th><th className={`${th} text-left`}>Goods</th><th className={`${th} text-right`}>Qty</th><th className={`${th} text-right`}>Value</th></tr></thead>
                  <tbody className="divide-y">{d.sent.map((l) => (
                    <tr key={l.lineId}><td className="px-3 py-2">{l.number}<p className="text-[11px] text-muted-foreground">{fmt(l.date)}</p></td><td className="px-3 py-2">{l.worker}</td><td className="px-3 py-2">{l.description}</td><td className="px-3 py-2 text-right">{l.sent} {l.uqc}</td><td className="px-3 py-2 text-right"><Money value={l.valuePaise} /></td></tr>
                  ))}</tbody>
                </ReportTable>
              )}
            </Card>
            <Card className="gap-0 overflow-hidden p-0">
              <div className="border-b px-4 py-2.5 text-sm font-semibold">Table 5A · received back ({d.received.length})</div>
              {d.received.length === 0 ? <p className="p-4 text-sm text-muted-foreground">None.</p> : (
                <ReportTable>
                  <thead><tr className="border-b"><th className={`${th} text-left`}>Received</th><th className={`${th} text-left`}>Against</th><th className={`${th} text-left`}>Goods</th><th className={`${th} text-right`}>Back</th><th className={`${th} text-right`}>Waste</th></tr></thead>
                  <tbody className="divide-y">{d.received.map((r, i) => (
                    <tr key={i}><td className="px-3 py-2">{fmt(r.receivedDate)}<p className="text-[11px] text-muted-foreground">{r.jobWorkerChallanNo ?? ''}</p></td><td className="px-3 py-2">{r.challanNumber}</td><td className="px-3 py-2">{r.description}</td><td className="px-3 py-2 text-right">{r.qtyReceived}</td><td className="px-3 py-2 text-right">{r.qtyWaste}</td></tr>
                  ))}</tbody>
                </ReportTable>
              )}
            </Card>
          </>
        )}
      </AsyncPage>
    </div>
  );
}
