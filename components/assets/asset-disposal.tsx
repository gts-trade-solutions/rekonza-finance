'use client';

// The asset disposal workflow on screen (status review 7, item 9).
//
//   DisposePanel     sell by tax invoice, sell into a bank, or scrap — the
//                    whole asset or part of it — with what will post shown
//                    before anything does.
//   SplitPanel       part of an asset made an asset of its own (Ind AS 16
//                    componentisation; how part of one is disposed of).
//   DisposedSummary  a disposed asset: when, how, what it fetched, the gain
//                    or loss, its entries, and Undo disposal with a reason.
//   DisposalsTab     the Disposals report, tied to the ledger, with the
//                    disposals waiting for approval and those undone.
//   ScheduleTab      the fixed asset schedule (Schedule III note): opening,
//                    additions, disposals, depreciation, closing — tied.
//   DisposalApprovalCard  who must approve a disposal, if anyone.

import { useMemo, useState } from 'react';
import { CheckCircle2, Download, FileText, Loader2, Printer, Scissors, ShieldCheck, Undo2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Money } from '@/components/shared/money';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { ContactPicker } from '@/components/forms/quick-create';
import { downloadCsv, ReportTable } from '@/components/shared/report-shell';
import { useConfirmDelete } from '@/components/shared/row-actions';
import { JournalDialog } from '@/components/sales/sales-doc-record';
import {
  assetDisposals, fixedAssets, type AssetDetailFull, type AssetDisposalRecord, type DisposalReportRow,
} from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { usePermission } from '@/lib/store/hooks';

const today = () => new Date().toISOString().slice(0, 10);
const fmt = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
const rupees = (p: number) => `₹${(Math.abs(p) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const r2 = (p: number) => (p / 100).toFixed(2);
const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const currentFy = () => { const d = new Date(); return d.getMonth() < 3 ? d.getFullYear() - 1 : d.getFullYear(); };
const HOW: Record<string, string> = { invoice: 'Sold by tax invoice', bank: 'Sold, money into the bank', none: 'Scrapped' };

type How = 'invoice' | 'bank' | 'scrap';

/** Sell or scrap: the whole asset or part of it, with the entries it will post shown first. */
export function DisposePanel({ d, onDone }: { d: AssetDetailFull; onDone: (pending: boolean) => void }) {
  const a = d.asset;
  const banks = useAppStore((s) => s.bankAccounts).filter((b) => b.kind === 'bank' || b.kind === 'cash');
  const cost = d.costs.reduce((t, c) => t + c.amountPaise, 0);
  const [how, setHow] = useState<How>('invoice');
  const [part, setPart] = useState(false);
  const [f, setF] = useState({ date: today(), customerId: '', sale: 0, rate: 18, bankId: '', partCost: 0, reason: '' });
  const [busy, setBusy] = useState(false);
  const sale = how === 'scrap' ? 0 : f.sale;
  const partCost = part ? f.partCost : 0;
  const preview = useApi(
    () => assetDisposals.preview(a.id, { date: f.date, salePaise: sale, partCostPaise: partCost || undefined, via: how === 'scrap' ? 'none' : how }),
    [a.id, f.date, sale, partCost, how],
  );
  const advice = useApi(() => fixedAssets.saleAdvice(a.id, f.date), [a.id, f.date]);
  const approval = useApi(() => assetDisposals.approval(), []);
  const tax = how === 'invoice' ? Math.round((f.sale * f.rate) / 100) : 0;
  const minimum = Math.round((advice.data?.minimumTaxPaise ?? 0) * (part && cost ? f.partCost / cost : 1));
  const p = preview.data;
  const stake = Math.max(p?.writtenDownPaise ?? 0, sale);
  const needsApproval = !!approval.data?.isActive && stake >= (approval.data?.thresholdPaise ?? 0);
  const ready = !!f.date && (!part || (f.partCost > 0 && f.partCost < cost))
    && (how === 'scrap' || (f.sale > 0 && (how === 'invoice' ? !!f.customerId : !!f.bankId)))
    && !(p?.problems.length);

  const dispose = async () => {
    setBusy(true);
    try {
      const r = await fixedAssets.act<{ pending: boolean; invoiceNumber: string | null; gainPaise: number; shortTaxPaise: number; approverRole: string | null }>({
        action: 'dispose', id: a.id, date: f.date, kind: how === 'scrap' ? 'scrapped' : 'sold',
        proceedsVia: how === 'scrap' ? null : how, customerId: how === 'invoice' ? f.customerId : null,
        bankAccountId: how === 'bank' ? f.bankId : null, salePaise: how === 'scrap' ? null : f.sale,
        gstRatePct: how === 'invoice' ? f.rate : null, partCostPaise: part ? f.partCost : null, reason: f.reason || null,
      });
      if (r.pending) {
        toast.success('Disposal sent for approval', { description: `Nothing is posted until ${r.approverRole === 'admin' ? 'an admin' : `an ${r.approverRole}`} other than you approves it (Disposals tab).` });
      } else {
        toast.success(`${how === 'scrap' ? 'Scrapped' : `Sold${r.invoiceNumber ? ` by ${r.invoiceNumber}` : ''}`}: ${r.gainPaise >= 0 ? 'gain' : 'loss'} ${rupees(r.gainPaise)}`, {
          description: r.shortTaxPaise > 0 ? `GST on the invoice is ${rupees(r.shortTaxPaise)} below the minimum under section 18(6); pay the difference in GSTR-3B.` : 'Depreciation to the day before, and the disposal, are posted.',
        });
      }
      onDone(r.pending);
    } catch (e) {
      toast.error('Not disposed of', { description: err(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border border-destructive/30 p-3" data-slot="dispose-panel">
      <div>
        <p className="text-sm font-medium">Dispose of it</p>
        <p className="text-xs text-muted-foreground">Depreciation from the last run to the day before it leaves posts first (Schedule II), then one disposal entry with the gain or loss.</p>
      </div>
      <div className="flex rounded-md border p-0.5 text-xs" role="radiogroup" aria-label="How it leaves">
        {([['invoice', 'Sold — tax invoice to a buyer'], ['bank', 'Sold — money into a bank, no invoice'], ['scrap', 'Scrapped, nothing received']] as const).map(([k, l]) => (
          <button key={k} type="button" role="radio" aria-checked={how === k} onClick={() => setHow(k)} data-slot={`dispose-how-${k}`}
            className={`flex-1 rounded px-2 py-1.5 ${how === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>{l}</button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Date it left" required><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} data-slot="dispose-date" /></Field>
        <Field label="What is disposed of">
          <Select value={part ? 'part' : 'whole'} onValueChange={(v) => setPart(v === 'part')}>
            <SelectTrigger data-slot="dispose-whole-part"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="whole">The whole asset</SelectItem>
              <SelectItem value="part">Part of it (split off first)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {part && (
          <Field label="Cost of the part" required hint={`Of ${rupees(cost)}; the same share of its depreciation goes with it`} className="sm:col-span-2">
            <div className="flex items-center gap-2">
              <MoneyInput valuePaise={f.partCost} onChangePaise={(v) => setF({ ...f, partCost: v })} />
              {[25, 50].map((pct) => (
                <Button key={pct} type="button" size="xs" variant="outline" onClick={() => setF({ ...f, partCost: Math.round((cost * pct) / 100) })}>{pct}%</Button>
              ))}
            </div>
          </Field>
        )}
        {how === 'invoice' && (
          <>
            <Field label="Buyer" required><ContactPicker kind="customer" value={f.customerId} onChange={(x) => setF({ ...f, customerId: x })} /></Field>
            <Field label="Sale value before GST" required><MoneyInput valuePaise={f.sale} onChangePaise={(v) => setF({ ...f, sale: v })} /></Field>
            <Field label="GST rate %"><Input type="number" min={0} max={40} value={f.rate} onChange={(e) => setF({ ...f, rate: Number(e.target.value) })} /></Field>
          </>
        )}
        {how === 'bank' && (
          <>
            <Field label="Received into" required>
              <Select value={f.bankId} onValueChange={(v) => setF({ ...f, bankId: String(v) })}>
                <SelectTrigger data-slot="dispose-bank"><SelectValue placeholder="Bank account" /></SelectTrigger>
                <SelectContent>{banks.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Amount received" required><MoneyInput valuePaise={f.sale} onChangePaise={(v) => setF({ ...f, sale: v })} /></Field>
          </>
        )}
        <Field label="Reason or note" className="sm:col-span-2"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Replaced by a new model; worn out; insurance claim…" /></Field>
      </div>
      {how === 'bank' && <p className="text-xs text-muted-foreground">No tax invoice is raised: use this when GST does not apply (an unregistered business, an insurer settling a claim). A registered business selling a used asset sells by tax invoice.</p>}
      {how === 'invoice' && minimum > 0 && (
        <p className={`text-xs ${tax < minimum ? 'text-destructive' : 'text-muted-foreground'}`}>
          Credit of <Money value={advice.data?.itcClaimedPaise ?? 0} /> was taken on it. GST on its sale must be at least <Money value={minimum} /> —
          the credit less five percentage points a quarter (section 18(6), rule 44(6)). At {f.rate}% this sale carries <Money value={tax} />.
        </p>
      )}
      {how === 'invoice' && !a.hsnSac && <p className="text-xs text-destructive">Add the asset&apos;s HSN code first (Details tab): the invoice needs it.</p>}

      {p && (
        <div className="space-y-2 rounded-md bg-muted/40 p-2.5" data-slot="dispose-preview">
          <p className="text-xs font-medium">What will post</p>
          {p.problems.map((x) => <p key={x} className="text-xs text-destructive">{x}</p>)}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
            <span className="text-muted-foreground">Cost</span><Money value={p.costPaise} className="text-right" />
            <span className="text-muted-foreground">Depreciation so far</span><Money value={p.chargedPaise} className="text-right" />
            <span className="text-muted-foreground">To the day before{p.catchUpFrom ? ` (${fmt(p.catchUpFrom)}–${fmt(p.catchUpTo)})` : ''}</span><Money value={p.catchUpPaise} className="text-right" />
            <span className="text-muted-foreground">Written-down value</span><Money value={p.writtenDownPaise} className="text-right" />
            <span className="text-muted-foreground">Proceeds</span><Money value={p.salePaise} className="text-right" />
            <span className="font-medium">{p.gainPaise >= 0 ? 'Gain' : 'Loss'}</span><Money value={p.gainPaise} colored className="text-right font-medium" />
          </div>
          <table className="w-full text-xs">
            <thead><tr className="text-[10px] uppercase text-muted-foreground"><th className="py-1 text-left">Entry</th><th className="py-1 text-left">Account</th><th className="py-1 text-right">Dr</th><th className="py-1 text-right">Cr</th></tr></thead>
            <tbody>
              {p.lines.map((l, i) => (
                <tr key={i} className="border-t border-border/50">
                  <td className="py-1 text-muted-foreground">{l.entry === 1 ? 'Depreciation' : 'Disposal'}</td>
                  <td className="py-1">{l.account}</td>
                  <td className="py-1 text-right">{l.debitPaise ? <Money value={l.debitPaise} /> : ''}</td>
                  <td className="py-1 text-right">{l.creditPaise ? <Money value={l.creditPaise} /> : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {needsApproval && <p className="text-xs font-medium text-amber-700 dark:text-amber-300">This book wants disposals of {rupees(approval.data!.thresholdPaise)} and above approved: it will wait for {approval.data!.approverRole === 'admin' ? 'an admin' : `an ${approval.data!.approverRole}`} other than you, with nothing posted.</p>}
        </div>
      )}
      <div className="flex justify-end">
        <Button size="sm" variant="destructive" onClick={() => void dispose()} disabled={busy || !ready} data-slot="dispose-submit">
          {busy && <Loader2 className="size-4 animate-spin" />} {needsApproval ? 'Send for approval' : how === 'scrap' ? 'Scrap' : 'Sell'}{part ? ' the part' : ''}
        </Button>
      </div>
    </div>
  );
}

/** Split part of an asset into one of its own, nothing posted. */
export function SplitPanel({ d, onDone }: { d: AssetDetailFull; onDone: () => void }) {
  const cost = d.costs.reduce((t, c) => t + c.amountPaise, 0);
  const [f, setF] = useState({ partCost: 0, name: `${d.asset.name} (part)`, tagNo: '' });
  const [busy, setBusy] = useState(false);
  const split = async () => {
    setBusy(true);
    try {
      const r = await fixedAssets.act<{ tagNo: string }>({ action: 'split', id: d.asset.id, partCostPaise: f.partCost, name: f.name, tagNo: f.tagNo || null });
      toast.success(`Split off as ${r.tagNo}`, { description: 'Its share of the cost and depreciation moved; nothing was posted, as both stay in the same ledger.' });
      onDone();
    } catch (e) {
      toast.error('Not split', { description: err(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 rounded-md border p-3" data-slot="split-panel">
      <p className="flex items-center gap-1.5 text-sm font-medium"><Scissors className="size-3.5" /> Split asset</p>
      <p className="text-xs text-muted-foreground">Part of it becomes an asset of its own — a component with its own life, or the part about to be sold. Its share of the cost and the depreciation goes with it; the rest stays here.</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <Field label="Cost of the part" hint={`Of ${rupees(cost)}`}><MoneyInput valuePaise={f.partCost} onChangePaise={(v) => setF({ ...f, partCost: v })} /></Field>
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Tag" hint={`Blank: ${d.asset.tagNo}-1`}><Input value={f.tagNo} onChange={(e) => setF({ ...f, tagNo: e.target.value })} className="font-mono" /></Field>
      </div>
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={() => void split()} disabled={busy || !(f.partCost > 0 && f.partCost < cost)} data-slot="split-submit">Split</Button>
      </div>
    </div>
  );
}

/** A disposed asset: how it left, the money, the entries, and Undo. */
export function DisposedSummary({ d, onChanged }: { d: AssetDetailFull; onChanged: () => void }) {
  const canUndo = usePermission('accountant', 'void');
  const confirm = useConfirmDelete();
  const [journal, setJournal] = useState<{ id: string; label: string } | null>(null);
  const x = d.disposals.find((r) => r.status === 'posted');
  const a = d.asset;
  if (a.status !== 'disposed') return null;
  const undo = () => confirm.ask({
    title: `Undo the disposal of ${a.name}?`,
    description: `Its depreciation to the day it left and the disposal entry are reversed on their own dates${x?.invoiceNo ? `, invoice ${x.invoiceNo} is voided (refused while money is received against it)` : ''}, and it goes back into use with the depreciation it missed since. The disposal stays on record, marked undone.`,
    reasonRequired: true, tone: 'default', confirmLabel: 'Undo disposal', failTitle: 'Not undone',
    run: (reason) => fixedAssets.act({ action: 'undo-disposal', id: a.id, reason }),
    done: 'Disposal undone', doneDescription: 'The asset is back in the register and in the next depreciation run.', onDone: onChanged,
  });
  return (
    <Card className="space-y-2 border-muted-foreground/20 p-3" data-slot="disposed-summary">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{HOW[x?.via ?? (a.disposalKind === 'sold' ? 'invoice' : 'none')]} on {fmt(a.disposedOn)}</p>
        {canUndo && <Button size="sm" variant="outline" className="gap-1.5" onClick={undo} data-slot="asset-undo-disposal"><Undo2 className="size-3.5" /> Undo disposal</Button>}
      </div>
      {x && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
          <span className="text-muted-foreground">Cost</span><Money value={x.costPaise} className="text-right" />
          <span className="text-muted-foreground">Depreciation to the day before</span><Money value={x.accumulatedPaise} className="text-right" />
          <span className="text-muted-foreground">of which at disposal</span><Money value={x.catchUpPaise} className="text-right" />
          <span className="text-muted-foreground">Proceeds{x.gstPaise ? ' (before GST)' : ''}</span><Money value={x.salePaise} className="text-right" />
          {x.gstPaise > 0 && <><span className="text-muted-foreground">GST on the invoice</span><Money value={x.gstPaise} className="text-right" /></>}
          <span className="font-medium">{x.gainPaise >= 0 ? 'Gain' : 'Loss'}</span><Money value={x.gainPaise} colored className="text-right font-medium" />
        </div>
      )}
      <div className="flex flex-wrap gap-2 text-xs">
        {x?.invoiceNo && <a className="text-primary hover:underline" href={`/sales/invoices/${x.invoiceId}`}>Invoice {x.invoiceNo}</a>}
        {x?.bankName && <span className="text-muted-foreground">Into {x.bankName}</span>}
        {x?.depreciationEntryId && <button type="button" className="text-primary hover:underline" onClick={() => setJournal({ id: x.depreciationEntryId!, label: 'depreciation to the day it left' })}>Depreciation entry</button>}
        {x?.entryId && <button type="button" className="text-primary hover:underline" onClick={() => setJournal({ id: x.entryId!, label: 'the disposal' })} data-slot="disposal-journal">Disposal entry</button>}
        {x?.reason && <span className="text-muted-foreground">· {x.reason}</span>}
      </div>
      {journal && <JournalDialog entryId={journal.id} number={journal.label} onClose={() => setJournal(null)} />}
      {confirm.dialog}
    </Card>
  );
}

/** Every disposal on record for an asset, undone and sent back ones included. */
export function DisposalHistory({ disposals }: { disposals: AssetDisposalRecord[] }) {
  const old = disposals.filter((x) => x.status !== 'posted');
  if (!old.length) return null;
  return (
    <ul className="divide-y rounded-md border text-xs" data-slot="disposal-history">
      {old.map((x) => (
        <li key={x.id} className="px-3 py-2">
          <span className="font-medium">{x.status === 'undone' ? 'Disposal undone' : x.status === 'rejected' ? 'Disposal sent back' : 'Disposal waiting for approval'}</span>
          {' · '}{HOW[x.via]} on {fmt(x.date)}
          {x.status === 'undone' && <> · undone {x.undoneAt ? fmt(x.undoneAt) : ''}{x.undoneBy ? ` by ${x.undoneBy}` : ''}: {x.undoReason}</>}
          {x.status === 'rejected' && <> · {x.rejectedReason}</>}
        </li>
      ))}
    </ul>
  );
}

/** The Disposals report, tied to the ledger. */
export function DisposalsTab({ onOpen }: { onOpen: (id: string) => void }) {
  const fy = currentFy();
  const [from, setFrom] = useState(`${fy}-04-01`);
  const [to, setTo] = useState(today());
  const state = useApi(() => assetDisposals.report(from, to), [from, to]);
  const canEdit = usePermission('accountant', 'edit');
  const me = useAppStore((s) => s.session?.userId);
  const [journal, setJournal] = useState<{ id: string; label: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const data = state.data;
  const rows = data?.rows ?? [];
  const decide = async (id: string, approve: boolean) => {
    const reason = approve ? null : window.prompt('Why is it sent back?');
    if (!approve && !reason) return;
    setBusy(id);
    try {
      await fixedAssets.act(approve ? { action: 'approve-disposal', disposalId: id } : { action: 'reject-disposal', disposalId: id, reason });
      toast.success(approve ? 'Approved and posted' : 'Sent back; nothing was posted');
      void state.refetch();
    } catch (e) {
      toast.error('Not done', { description: err(e) });
    } finally {
      setBusy(null);
    }
  };
  const exportIt = () => downloadCsv(`asset-disposals-${from}-${to}.csv`, [
    ['Tag', 'Asset', 'Class', 'Acquired', 'Disposed', 'How', 'Invoice / bank', 'Cost', 'Accumulated depreciation', 'of which to disposal', 'Written-down value', 'Proceeds', 'GST', 'Gain (loss)'],
    ...rows.map((r) => [r.tagNo, r.name, r.className, r.acquiredOn, r.disposedOn, HOW[r.via], r.invoiceNumber ?? r.bankName ?? '', r2(r.costPaise), r2(r.accumulatedPaise), r2(r.catchUpPaise), r2(r.writtenDownPaise), r2(r.proceedsPaise), r2(r.gstPaise), r2(r.gainPaise)]),
    ['', 'Total', '', '', '', '', '', r2(data?.totals.costPaise ?? 0), r2(data?.totals.accumulatedPaise ?? 0), '', r2(data?.totals.writtenDownPaise ?? 0), r2(data?.totals.proceedsPaise ?? 0), r2(data?.totals.gstPaise ?? 0), r2(data?.totals.gainPaise ?? 0)],
    [],
    ['General ledger', 'Profit on Sale of Fixed Assets', r2(data?.ledger.profitPaise ?? 0)],
    ['', 'Loss on Sale or Discard of Fixed Assets', r2(data?.ledger.lossPaise ?? 0)],
    ['', 'Net gain from the disposal entries', r2(data?.ledger.fromDisposalsPaise ?? 0)],
    ['', 'Difference from the register', r2(data?.differencePaise ?? 0)],
  ]);
  return (
    <div className="space-y-4" data-slot="asset-disposals">
      {(data?.pending.length ?? 0) > 0 && (
        <Card className="space-y-2 border-amber-500/40 p-4" data-slot="disposals-pending">
          <p className="flex items-center gap-1.5 text-sm font-semibold"><ShieldCheck className="size-4 text-amber-600" /> Waiting for approval ({data!.pending.length})</p>
          <ReportTable>
            <thead><tr className="border-b bg-muted/50"><th className={`${th} text-left`}>Asset</th><th className={`${th} text-left`}>Date</th><th className={`${th} text-left`}>How</th><th className={`${th} text-right`}>Proceeds</th><th className={`${th} text-left`}>Asked by</th><th className="w-48" /></tr></thead>
            <tbody>
              {data!.pending.map((x) => (
                <tr key={x.id} className="border-b last:border-0">
                  <td className="px-3 py-2 text-sm"><span className="font-mono text-xs text-muted-foreground">{x.tagNo}</span> {x.name}{x.partCostPaise ? <span className="block text-xs text-muted-foreground">Part costing <Money value={x.partCostPaise} /></span> : null}{x.reason && <span className="block text-xs text-muted-foreground">{x.reason}</span>}</td>
                  <td className="px-3 py-2 text-xs">{fmt(x.date)}</td>
                  <td className="px-3 py-2 text-xs">{x.kind === 'scrapped' ? 'Scrapped' : HOW[x.proceedsVia]}{x.buyer ? ` to ${x.buyer}` : ''}</td>
                  <td className="px-3 py-2 text-right"><Money value={x.salePaise} /></td>
                  <td className="px-3 py-2 text-xs">{x.requestedBy}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right">
                    {canEdit && x.requestedById !== me && (
                      <>
                        <Button size="xs" className="mr-1 gap-1" disabled={busy === x.id} onClick={() => void decide(x.id, true)} data-slot="disposal-approve"><CheckCircle2 className="size-3" /> Approve</Button>
                        <Button size="xs" variant="outline" className="gap-1" disabled={busy === x.id} onClick={() => void decide(x.id, false)} data-slot="disposal-reject"><XCircle className="size-3" /> Send back</Button>
                      </>
                    )}
                    {x.requestedById === me && <span className="text-[11px] text-muted-foreground">Someone else approves it</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </ReportTable>
        </Card>
      )}

      <Card className="overflow-hidden p-0">
        <div className="no-print flex flex-wrap items-end gap-3 border-b px-4 py-3">
          <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-40" /></Field>
          <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-40" /></Field>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => window.print()}><Printer className="size-3.5" /> Print</Button>
            <Button size="sm" variant="outline" className="gap-1.5" disabled={!rows.length} onClick={exportIt} data-slot="disposals-export"><Download className="size-3.5" /> Export</Button>
          </div>
        </div>
        <div className="px-4 pt-3">
          <h3 className="text-sm font-semibold">Disposals report</h3>
          <p className="text-xs text-muted-foreground">Assets sold or scrapped from {fmt(from)} to {fmt(to)}: cost, depreciation to the day each left, written-down value, what it fetched and the gain or loss.</p>
        </div>
        {rows.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground" data-slot="disposals-empty">{state.loading ? 'Loading…' : 'No asset was sold or scrapped in this period. To dispose of one, open it from the Register and use Verify & dispose.'}</p>
        ) : (
          <ReportTable>
            <thead>
              <tr className="border-b bg-muted/50">
                <th className={`${th} text-left`}>Asset</th><th className={`${th} text-left`}>Disposed</th><th className={`${th} text-left`}>How</th>
                <th className={`${th} text-right`}>Cost</th><th className={`${th} text-right`}>Acc. depreciation</th><th className={`${th} text-right`}>WDV</th>
                <th className={`${th} text-right`}>Proceeds</th><th className={`${th} text-right`}>GST</th><th className={`${th} text-right`}>Gain (loss)</th><th className={th} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r: DisposalReportRow) => (
                <tr key={r.disposalId} className="cursor-pointer border-b hover:bg-row-hover" onClick={() => onOpen(r.id)} data-slot="disposal-row">
                  <td className="px-3 py-2 text-sm"><span className="font-mono text-xs text-muted-foreground">{r.tagNo}</span> {r.name}<span className="block text-xs text-muted-foreground">{r.className}{r.partOf ? ` · part of ${r.partOf}` : ''}</span></td>
                  <td className="px-3 py-2 text-xs">{fmt(r.disposedOn)}</td>
                  <td className="px-3 py-2 text-xs">{HOW[r.via]}{r.invoiceNumber ? <span className="block text-muted-foreground">{r.invoiceNumber}{r.buyer ? ` · ${r.buyer}` : ''}</span> : r.bankName ? <span className="block text-muted-foreground">{r.bankName}</span> : null}</td>
                  <td className="px-3 py-2 text-right"><Money value={r.costPaise} /></td>
                  <td className="px-3 py-2 text-right"><Money value={r.accumulatedPaise} /></td>
                  <td className="px-3 py-2 text-right"><Money value={r.writtenDownPaise} /></td>
                  <td className="px-3 py-2 text-right"><Money value={r.proceedsPaise} /></td>
                  <td className="px-3 py-2 text-right"><Money value={r.gstPaise} showZero={false} /></td>
                  <td className="px-3 py-2 text-right"><Money value={r.gainPaise} colored /></td>
                  <td className="px-2 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                    {r.entryId && <Button size="xs" variant="ghost" className="gap-1" onClick={() => setJournal({ id: r.entryId!, label: `the disposal of ${r.tagNo}` })}><FileText className="size-3" /> Entry</Button>}
                  </td>
                </tr>
              ))}
              <tr className="border-t-2 bg-muted/40 font-semibold" data-slot="disposals-total">
                <td className="px-3 py-2" colSpan={3}>Total</td>
                <td className="px-3 py-2 text-right"><Money value={data!.totals.costPaise} /></td>
                <td className="px-3 py-2 text-right"><Money value={data!.totals.accumulatedPaise} /></td>
                <td className="px-3 py-2 text-right"><Money value={data!.totals.writtenDownPaise} /></td>
                <td className="px-3 py-2 text-right"><Money value={data!.totals.proceedsPaise} /></td>
                <td className="px-3 py-2 text-right"><Money value={data!.totals.gstPaise} /></td>
                <td className="px-3 py-2 text-right"><Money value={data!.totals.gainPaise} colored /></td>
                <td />
              </tr>
            </tbody>
          </ReportTable>
        )}
        {data && (
          <div className={`m-4 rounded-md border p-3 text-xs ${data.ties ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-destructive/40 bg-destructive/5'}`} data-slot="disposals-tie">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              {data.ties ? <CheckCircle2 className="size-4 text-emerald-600" /> : <XCircle className="size-4 text-destructive" />}
              {data.ties ? 'Ties to the general ledger' : `Differs from the ledger by ${rupees(data.differencePaise)}`}
            </p>
            <div className="mt-2 grid max-w-xl grid-cols-[1fr_auto] gap-x-6 gap-y-1">
              <span>Profit on Sale of Fixed Assets (GL)</span><Money value={data.ledger.profitPaise} />
              <span>Loss on Sale or Discard of Fixed Assets (GL)</span><Money value={-data.ledger.lossPaise} />
              <span>Net, from the disposal entries</span><Money value={data.ledger.fromDisposalsPaise} className="font-medium" />
              <span>Gain (loss) in this report</span><Money value={data.totals.gainPaise} className="font-medium" />
              {data.ledger.otherPaise !== 0 && <><span>Other entries in those ledgers (not disposals)</span><Money value={data.ledger.otherPaise} /></>}
            </div>
            {data.ledger.other.map((o) => (
              <button key={o.entryId} type="button" className="mt-1 block text-primary hover:underline" onClick={() => setJournal({ id: o.entryId, label: `entry ${o.entryNo}` })}>
                Entry {o.entryNo} · {fmt(o.date)} · {o.memo} · {rupees(o.amountPaise)}
              </button>
            ))}
          </div>
        )}
      </Card>

      {(data?.undone.length ?? 0) > 0 && (
        <Card className="p-4" data-slot="disposals-undone">
          <p className="text-sm font-semibold">Disposals undone in this period</p>
          <ul className="mt-2 divide-y text-xs">
            {data!.undone.map((u) => (
              <li key={u.disposalId} className="py-1.5"><button type="button" className="text-primary hover:underline" onClick={() => onOpen(u.assetId)}>{u.tagNo} {u.name}</button> · disposed {fmt(u.disposedOn)} · undone {fmt(u.undoneAt)}{u.by ? ` by ${u.by}` : ''} — {u.reason}</li>
            ))}
          </ul>
        </Card>
      )}
      {journal && <JournalDialog entryId={journal.id} number={journal.label} onClose={() => setJournal(null)} />}
    </div>
  );
}

/** The fixed asset schedule, as the notes to the accounts print it, with its ties to the ledger. */
export function ScheduleTab() {
  const [fy, setFy] = useState(currentFy());
  const state = useApi(() => assetDisposals.schedule(fy), [fy]);
  const d = state.data;
  const cols = useMemo(() => [
    ['grossOpeningPaise', 'Gross: opening'], ['additionsPaise', 'Additions'], ['disposalsPaise', 'Disposals'], ['grossClosingPaise', 'Gross: closing'],
    ['depOpeningPaise', 'Dep.: opening'], ['depForYearPaise', 'For the year'], ['depOnDisposalsPaise', 'On disposals'], ['depClosingPaise', 'Dep.: closing'],
    ['netOpeningPaise', 'Net: opening'], ['netClosingPaise', 'Net: closing'],
  ] as const, []);
  const exportIt = () => d && downloadCsv(`fixed-asset-schedule-FY${fy}-${String(fy + 1).slice(2)}.csv`, [
    ['Class', ...cols.map(([, l]) => l)],
    ...d.rows.map((r) => [r.label, ...cols.map(([k]) => r2(r[k]))]),
    ['Total', ...cols.map(([k]) => r2(d.total[k]))],
    [],
    ['Capital work-in-progress', 'Opening', r2(d.cwip.openingPaise), 'Spent', r2(d.cwip.additionsPaise), 'Put to use', r2(d.cwip.capitalisedPaise), 'Closing', r2(d.cwip.closingPaise)],
    [],
    ['Check', 'Register', 'Ledger', 'Difference'],
    ...d.ties.map((t) => [t.label, r2(t.registerPaise), r2(t.ledgerPaise), r2(t.differencePaise)]),
  ]);
  return (
    <div className="space-y-4" data-slot="asset-schedule">
      <div className="no-print flex flex-wrap items-center gap-2">
        <Select value={String(fy)} onValueChange={(v) => setFy(Number(v))}>
          <SelectTrigger className="h-9 w-40" data-slot="schedule-fy"><SelectValue /></SelectTrigger>
          <SelectContent>{[0, 1, 2, 3].map((i) => currentFy() - i).map((y) => <SelectItem key={y} value={String(y)}>FY {y}-{String((y + 1) % 100).padStart(2, '0')}</SelectItem>)}</SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">Property, plant and equipment as the notes to the accounts set it out (Schedule III, Division I).</p>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => window.print()}><Printer className="size-3.5" /> Print</Button>
          <Button size="sm" variant="outline" className="gap-1.5" disabled={!d} onClick={exportIt} data-slot="schedule-export"><Download className="size-3.5" /> Export</Button>
        </div>
      </div>
      {!d ? <p className="text-sm text-muted-foreground">{state.error ?? 'Loading…'}</p> : d.rows.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No assets held or moved in FY {fy}-{String((fy + 1) % 100).padStart(2, '0')}. Add one from the Add asset button.</p>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/50"><th className={`${th} text-left`} rowSpan={2}>Class</th><th className={`${th} text-center`} colSpan={4}>Gross block</th><th className={`${th} text-center`} colSpan={4}>Depreciation</th><th className={`${th} text-center`} colSpan={2}>Net block</th></tr>
              <tr className="border-b bg-muted/30">{cols.map(([, l]) => <th key={l} className={`${th} text-right`}>{l.replace(/^(Gross|Dep\.|Net): /, '')}</th>)}</tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.key} className="border-b" data-slot="schedule-row"><td className="px-3 py-2 font-medium">{r.label}</td>{cols.map(([k]) => <td key={k} className="px-3 py-2 text-right"><Money value={r[k]} showZero={false} /></td>)}</tr>
              ))}
              <tr className="border-t-2 bg-muted/40 font-semibold" data-slot="schedule-total"><td className="px-3 py-2">Total</td>{cols.map(([k]) => <td key={k} className="px-3 py-2 text-right"><Money value={d.total[k]} /></td>)}</tr>
            </tbody>
          </table>
        </Card>
      )}
      {d && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-4 text-xs">
            <p className="text-sm font-semibold">Capital work-in-progress</p>
            <div className="mt-2 grid grid-cols-[1fr_auto] gap-y-1">
              <span>Opening</span><Money value={d.cwip.openingPaise} />
              <span>Spent in the year</span><Money value={d.cwip.additionsPaise} />
              <span>Put to use (to the classes above)</span><Money value={-d.cwip.capitalisedPaise} />
              <span className="font-medium">Closing</span><Money value={d.cwip.closingPaise} className="font-medium" />
            </div>
          </Card>
          <Card className="p-4 text-xs" data-slot="schedule-ties">
            <p className="text-sm font-semibold">Against the ledger at {fmt(d.to)}</p>
            <table className="mt-2 w-full">
              <thead><tr className="text-[10px] uppercase text-muted-foreground"><th className="py-1 text-left">Check</th><th className="py-1 text-right">Register</th><th className="py-1 text-right">Ledger</th><th className="py-1 text-right">Result</th></tr></thead>
              <tbody>
                {d.ties.map((t) => (
                  <tr key={t.label} className="border-t">
                    <td className="py-1">{t.label}</td>
                    <td className="py-1 text-right"><Money value={t.registerPaise} /></td>
                    <td className="py-1 text-right"><Money value={t.ledgerPaise} /></td>
                    <td className="py-1 text-right">{t.differencePaise === 0
                      ? <Badge variant="outline" className="border-emerald-500/40 text-[10px] text-emerald-700">Pass</Badge>
                      : <Badge variant="outline" className="border-destructive/40 text-[10px] text-destructive">Differs <Money value={t.differencePaise} /></Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-muted-foreground">A difference means something was posted to that ledger outside the register (a bill or journal straight to it): add that asset to the register, or move the entry.</p>
          </Card>
        </div>
      )}
    </div>
  );
}

/** Who approves a disposal before it posts, if anyone. Admins only. */
export function DisposalApprovalCard() {
  const isAdmin = useAppStore((s) => s.session?.role) === 'admin';
  const state = useApi(() => assetDisposals.approval(), []);
  const [f, setF] = useState<{ isActive: boolean; threshold: number; role: string } | null>(null);
  const v = f ?? (state.data ? { isActive: state.data.isActive, threshold: state.data.thresholdPaise, role: state.data.approverRole } : null);
  if (!v) return null;
  const save = async () => {
    try {
      await fixedAssets.act({ action: 'disposal-approval', isActive: v.isActive, thresholdPaise: v.threshold, approverRole: v.role });
      toast.success(v.isActive ? 'Disposals will wait for approval' : 'Disposals post at once');
      setF(null);
      void state.refetch();
    } catch (e) {
      toast.error('Not saved', { description: err(e) });
    }
  };
  return (
    <Card className="space-y-3 p-4" data-slot="disposal-approval">
      <div>
        <p className="text-sm font-semibold">Disposal approval</p>
        <p className="text-xs text-muted-foreground">Maker and checker for assets leaving the books: a disposal whose written-down value or proceeds reach the amount waits, with nothing posted, until a person with the role (other than the one who asked) approves it.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-[auto_12rem_12rem_auto] sm:items-end">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.isActive} disabled={!isAdmin} onChange={(e) => setF({ ...v, isActive: e.target.checked })} data-slot="disposal-approval-on" /> Disposals need approval</label>
        <Field label="From (₹, WDV or proceeds)"><MoneyInput valuePaise={v.threshold} onChangePaise={(p) => setF({ ...v, threshold: p })} /></Field>
        <Field label="Approved by">
          <Select value={v.role} onValueChange={(r) => setF({ ...v, role: String(r) })} disabled={!isAdmin}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="admin">An admin</SelectItem><SelectItem value="accountant">An accountant</SelectItem></SelectContent>
          </Select>
        </Field>
        {isAdmin && <Button size="sm" variant="outline" onClick={() => void save()} disabled={!f} data-slot="disposal-approval-save">Save</Button>}
      </div>
    </Card>
  );
}
