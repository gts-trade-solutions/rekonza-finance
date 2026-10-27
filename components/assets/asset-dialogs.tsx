'use client';

// The dialogs behind the fixed-asset register: adding an asset, an asset's
// own page with what can be done to it, and a class of assets.

import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Money } from '@/components/shared/money';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { ContactPicker } from '@/components/forms/quick-create';
import { accounts as accountApi, bills as billApi, fixedAssets, type AssetClassRow, type AssetDetail } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';

const today = () => new Date().toISOString().slice(0, 10);
const fmt = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Accounts money can come from to pay for an asset: banks, cash, payables, capital. */
function usePayingAccounts() {
  const state = useApi(() => accountApi.list(), []);
  return useMemo(() => (state.data?.accounts ?? [])
    .filter((a) => a.isActive && ((a.type === 'asset' && ['bank', 'cash'].includes(a.subtype ?? '')) || a.type === 'liability' || a.type === 'equity'))
    .map((a) => ({ value: a.id, label: `${a.code} ${a.name}` })), [state.data]);
}

// ── Adding an asset ──────────────────────────────────────────────────────────

export function AddAssetDialog({ open, classes, onClose, onDone }: {
  open: boolean; classes: AssetClassRow[]; onClose: () => void; onDone: (id: string) => void;
}) {
  const branches = useAppStore((s) => s.branches);
  const activeBranch = useAppStore((s) => s.activeBranchId);
  const paying = usePayingAccounts();
  const billsState = useApi(async () => (open ? billApi.list({ limit: 200 }) : null), [open]);
  const blank = {
    name: '', classId: '', branchId: activeBranch, source: 'paid' as 'paid' | 'bill' | 'opening', acquiredOn: today(),
    inUse: true, putToUseOn: today(), cost: 0, fromAccountId: '', billId: '', accumulated: 0, tagNo: '',
    location: '', custodian: '', serialNo: '', hsnSac: '', insurancePolicyNo: '', insuranceExpiry: '', amcVendor: '', amcExpiry: '',
  };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setF((x) => ({ ...x, branchId: x.branchId || activeBranch || branches[0]?.id || '' })); }, [open, activeBranch, branches]);

  const billOptions = (billsState.data?.bills ?? []).filter((b) => b.status !== 'void' && b.status !== 'draft')
    .map((b) => ({ value: b.id, label: `${b.internalNo} · ${b.vendorName}`, sublabel: `${b.vendorInvoiceNo} · ₹${(b.subtotalPaise / 100).toLocaleString('en-IN')}` }));

  const save = async () => {
    setBusy(true);
    try {
      const source = f.source === 'bill' ? { kind: 'bill', billId: f.billId }
        : f.source === 'paid' ? { kind: 'paid', fromAccountId: f.fromAccountId }
          : { kind: 'opening', accumulatedPaise: f.accumulated };
      const nul = (s: string) => s.trim() || null;
      const r = await fixedAssets.act<{ id: string; tagNo: string }>({
        action: 'add', branchId: f.branchId, classId: f.classId, name: f.name, acquiredOn: f.acquiredOn,
        putToUseOn: f.inUse ? f.putToUseOn : null, costPaise: f.cost, source, tagNo: nul(f.tagNo),
        location: nul(f.location), custodian: nul(f.custodian), serialNo: nul(f.serialNo), hsnSac: nul(f.hsnSac),
        insurancePolicyNo: nul(f.insurancePolicyNo), insuranceExpiry: f.insuranceExpiry || null,
        amcVendor: nul(f.amcVendor), amcExpiry: f.amcExpiry || null,
      });
      toast.success(`${f.name} added as ${r.tagNo}`);
      setF(blank);
      onDone(r.id);
    } catch (e) {
      toast.error('Not added', { description: err(e) });
    } finally {
      setBusy(false);
    }
  };

  const ready = f.name && f.classId && f.cost > 0 && (f.source !== 'paid' || f.fromAccountId) && (f.source !== 'bill' || f.billId);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add an asset</DialogTitle>
          <DialogDescription>Where its cost came from decides what is posted. Bought on a bill already entered, nothing is posted twice.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1 thin-scroll">
          <div className="flex rounded-md border p-0.5 text-xs">
            {([['paid', 'Paid directly'], ['bill', 'From a bill'], ['opening', 'Owned before the books start']] as const).map(([k, l]) => (
              <button key={k} type="button" onClick={() => setF({ ...f, source: k })}
                className={`flex-1 rounded px-2.5 py-1.5 ${f.source === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>{l}</button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Asset" required className="sm:col-span-2"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="CNC lathe, Dell laptop, Tata Ace…" /></Field>
            <Field label="Class" required>
              <Select value={f.classId} onValueChange={(v) => setF({ ...f, classId: v })}>
                <SelectTrigger><SelectValue placeholder="Pick a class" /></SelectTrigger>
                <SelectContent>{classes.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Branch" required>
              <Select value={f.branchId} onValueChange={(v) => setF({ ...f, branchId: v })}>
                <SelectTrigger><SelectValue placeholder="Branch" /></SelectTrigger>
                <SelectContent>{branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Cost" required hint="Before GST, plus freight and installation"><MoneyInput valuePaise={f.cost} onChangePaise={(p) => setF({ ...f, cost: p })} /></Field>
            <Field label="Acquired on" required><Input type="date" value={f.acquiredOn} onChange={(e) => setF({ ...f, acquiredOn: e.target.value })} /></Field>
            {f.source === 'paid' && (
              <Field label="Paid from" required className="sm:col-span-2">
                <Combobox options={paying} value={f.fromAccountId} onChange={(v) => setF({ ...f, fromAccountId: v })} showAvatar={false} placeholder="Bank, cash, or the payable" />
              </Field>
            )}
            {f.source === 'bill' && (
              <Field label="Bill" required className="sm:col-span-2" hint="Its line should be in a fixed-asset or CWIP ledger">
                <Combobox options={billOptions} value={f.billId} onChange={(v) => setF({ ...f, billId: v })} showAvatar={false} placeholder="Pick the bill" />
              </Field>
            )}
            {f.source === 'opening' && (
              <Field label="Depreciation written off before the books start" className="sm:col-span-2">
                <MoneyInput valuePaise={f.accumulated} onChangePaise={(p) => setF({ ...f, accumulated: p })} />
              </Field>
            )}
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" checked={f.inUse} onChange={(e) => setF({ ...f, inUse: e.target.checked })} />
              Already put to use — leave unticked while it is being built or installed (capital work in progress)
            </label>
            {f.inUse && <Field label="Put to use on" required><Input type="date" value={f.putToUseOn} onChange={(e) => setF({ ...f, putToUseOn: e.target.value })} /></Field>}
            <Field label="Tag number" hint="Left blank, the next FA- number"><Input value={f.tagNo} onChange={(e) => setF({ ...f, tagNo: e.target.value })} className="font-mono" /></Field>
            <Field label="Location"><Input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
            <Field label="Custodian"><Input value={f.custodian} onChange={(e) => setF({ ...f, custodian: e.target.value })} /></Field>
            <Field label="Serial number"><Input value={f.serialNo} onChange={(e) => setF({ ...f, serialNo: e.target.value })} /></Field>
            <Field label="HSN" hint="Needed when it is sold"><Input value={f.hsnSac} onChange={(e) => setF({ ...f, hsnSac: e.target.value })} /></Field>
            <Field label="Insurance policy"><Input value={f.insurancePolicyNo} onChange={(e) => setF({ ...f, insurancePolicyNo: e.target.value })} /></Field>
            <Field label="Insurance expires"><Input type="date" value={f.insuranceExpiry} onChange={(e) => setF({ ...f, insuranceExpiry: e.target.value })} /></Field>
            <Field label="AMC with"><Input value={f.amcVendor} onChange={(e) => setF({ ...f, amcVendor: e.target.value })} /></Field>
            <Field label="AMC expires"><Input type="date" value={f.amcExpiry} onChange={(e) => setF({ ...f, amcExpiry: e.target.value })} /></Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !ready}>{busy && <Loader2 className="size-4 animate-spin" />} Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── An asset ─────────────────────────────────────────────────────────────────

export function AssetDialog({ id, canEdit, onClose, onChanged }: { id: string | null; canEdit: boolean; onClose: () => void; onChanged: () => void }) {
  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        {id && <AssetBody id={id} canEdit={canEdit} onChanged={onChanged} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function AssetBody({ id, canEdit, onChanged, onClose }: { id: string; canEdit: boolean; onChanged: () => void; onClose: () => void }) {
  const state = useApi<AssetDetail>(() => fixedAssets.get(id), [id]);
  const refresh = () => { void state.refetch(); onChanged(); };
  const d = state.data;
  if (!d) return <p className="py-6 text-sm text-muted-foreground">{state.error ?? 'Loading…'}</p>;
  const a = d.asset;
  const cost = d.costs.reduce((t, c) => t + c.amountPaise, 0);
  const charged = a.openingAccumulatedPaise + d.depreciation.reduce((t, l) => t + l.amountPaise, 0);

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <span className="font-mono text-sm text-muted-foreground">{a.tagNo}</span> {a.name}
          <Badge variant="outline" className="text-[10px]">{a.status === 'cwip' ? 'CWIP' : a.status === 'in_use' ? 'In use' : `${a.disposalKind === 'sold' ? 'Sold' : 'Scrapped'} ${fmt(a.disposedOn)}`}</Badge>
        </DialogTitle>
        <DialogDescription>
          {a.className} · {a.method.toUpperCase()} over {a.usefulLifeYears} years · acquired {fmt(a.acquiredOn)}
          {a.putToUseOn ? `, in use from ${fmt(a.putToUseOn)}` : ', not yet in use'}
          {a.vendorName ? ` · from ${a.vendorName}${a.billNo ? ` (${a.billNo})` : ''}` : ''}
        </DialogDescription>
      </DialogHeader>
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Cost</p><Money value={cost} className="font-semibold" /></div>
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Depreciation</p><Money value={charged} className="font-semibold" /></div>
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Net</p><Money value={a.status === 'disposed' ? 0 : cost - charged} className="font-semibold" /></div>
      </div>
      <Tabs defaultValue="history">
        <TabsList>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
          {canEdit && a.status !== 'disposed' && <TabsTrigger value="actions">{a.status === 'cwip' ? 'Build & capitalise' : 'Verify & dispose'}</TabsTrigger>}
        </TabsList>
        <TabsContent value="history" className="mt-3 max-h-72 space-y-3 overflow-y-auto thin-scroll">
          <ul className="divide-y rounded-md border text-sm">
            {d.costs.map((c) => (
              <li key={`c${c.id}`} className="flex justify-between gap-3 px-3 py-2">
                <span>{fmt(c.date)} · {c.kind === 'opening' ? 'Opening cost' : c.kind === 'addition' ? 'Added cost' : 'Cost'}{c.description ? ` — ${c.description}` : ''}</span>
                <Money value={c.amountPaise} />
              </li>
            ))}
            {a.openingAccumulatedPaise > 0 && (
              <li className="flex justify-between gap-3 px-3 py-2 text-muted-foreground"><span>Depreciation before the books start</span><Money value={-a.openingAccumulatedPaise} /></li>
            )}
            {d.depreciation.map((l) => (
              <li key={`d${l.id}`} className="flex justify-between gap-3 px-3 py-2 text-muted-foreground">
                <span>{fmt(l.from)} – {fmt(l.to)} · {l.days} days{l.disposal ? ' · to disposal' : ''}</span><Money value={-l.amountPaise} />
              </li>
            ))}
            {d.verifications.map((v) => (
              <li key={`v${v.id}`} className="flex justify-between gap-3 px-3 py-2">
                <span>{fmt(v.date)} · verified {v.found ? 'and found' : '— NOT FOUND'}{v.condition ? `, ${v.condition.replace('_', ' ')}` : ''}{v.location ? `, at ${v.location}` : ''}{v.by ? ` (${v.by})` : ''}</span>
              </li>
            ))}
          </ul>
          {a.invoiceNo && <p className="text-xs text-muted-foreground">Sold by invoice {a.invoiceNo} for <Money value={a.disposalValuePaise ?? 0} /> before GST.</p>}
        </TabsContent>
        <TabsContent value="details" className="mt-3"><Details d={d} canEdit={canEdit && a.status !== 'disposed'} onSaved={refresh} /></TabsContent>
        {canEdit && a.status !== 'disposed' && (
          <TabsContent value="actions" className="mt-3">
            {a.status === 'cwip' ? <CwipActions id={id} onDone={refresh} /> : <InUseActions d={d} onDone={() => { refresh(); }} onClose={onClose} />}
          </TabsContent>
        )}
      </Tabs>
    </>
  );
}

function Details({ d, canEdit, onSaved }: { d: AssetDetail; canEdit: boolean; onSaved: () => void }) {
  const a = d.asset;
  const [f, setF] = useState({
    location: a.location ?? '', custodian: a.custodian ?? '', serialNo: a.serialNo ?? '',
    insurancePolicyNo: a.insurancePolicyNo ?? '', insuranceExpiry: a.insuranceExpiry ?? '',
    amcVendor: a.amcVendor ?? '', amcExpiry: a.amcExpiry ?? '', notes: a.notes ?? '',
  });
  const save = async () => {
    try {
      const n = (s: string) => s.trim() || null;
      await fixedAssets.act({
        action: 'details', id: a.id, location: n(f.location), custodian: n(f.custodian), serialNo: n(f.serialNo),
        insurancePolicyNo: n(f.insurancePolicyNo), insuranceExpiry: f.insuranceExpiry || null,
        amcVendor: n(f.amcVendor), amcExpiry: f.amcExpiry || null, notes: n(f.notes),
      });
      toast.success('Saved');
      onSaved();
    } catch (e) {
      toast.error('Not saved', { description: err(e) });
    }
  };
  const input = (k: keyof typeof f, type = 'text') => (
    <Input type={type} value={f[k]} disabled={!canEdit} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
  );
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Location">{input('location')}</Field>
        <Field label="Custodian">{input('custodian')}</Field>
        <Field label="Serial number">{input('serialNo')}</Field>
        <Field label="Insurance policy">{input('insurancePolicyNo')}</Field>
        <Field label="Insurance expires">{input('insuranceExpiry', 'date')}</Field>
        <Field label="AMC with">{input('amcVendor')}</Field>
        <Field label="AMC expires">{input('amcExpiry', 'date')}</Field>
        <Field label="Notes">{input('notes')}</Field>
      </div>
      {canEdit && <div className="flex justify-end"><Button size="sm" onClick={() => void save()}>Save details</Button></div>}
    </div>
  );
}

function CwipActions({ id, onDone }: { id: string; onDone: () => void }) {
  const paying = usePayingAccounts();
  const [cost, setCost] = useState({ date: today(), amount: 0, from: '', description: '' });
  const [useOn, setUseOn] = useState(today());
  const addCost = async () => {
    try {
      await fixedAssets.act({ action: 'cost', id, date: cost.date, amountPaise: cost.amount, fromAccountId: cost.from, description: cost.description || null });
      toast.success('Cost added to capital work in progress');
      setCost({ ...cost, amount: 0, description: '' });
      onDone();
    } catch (e) {
      toast.error('Not added', { description: err(e) });
    }
  };
  const capitalise = async () => {
    if (!window.confirm('Put it to use? Its whole cost moves out of CWIP into its ledger, and depreciation starts from that day.')) return;
    try {
      await fixedAssets.act({ action: 'put-to-use', id, date: useOn });
      toast.success('Put to use');
      onDone();
    } catch (e) {
      toast.error('Not done', { description: err(e) });
    }
  };
  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-md border p-3">
        <p className="text-sm font-medium">Add cost</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Date"><Input type="date" value={cost.date} onChange={(e) => setCost({ ...cost, date: e.target.value })} /></Field>
          <Field label="Amount"><MoneyInput valuePaise={cost.amount} onChangePaise={(p) => setCost({ ...cost, amount: p })} /></Field>
          <Field label="Paid from"><Combobox options={paying} value={cost.from} onChange={(v) => setCost({ ...cost, from: v })} showAvatar={false} /></Field>
          <Field label="What for"><Input value={cost.description} onChange={(e) => setCost({ ...cost, description: e.target.value })} placeholder="Erection, freight…" /></Field>
        </div>
        <div className="flex justify-end"><Button size="sm" variant="outline" onClick={() => void addCost()} disabled={!cost.amount || !cost.from}>Add cost</Button></div>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3 rounded-md border p-3">
        <Field label="Put to use on"><Input type="date" value={useOn} onChange={(e) => setUseOn(e.target.value)} /></Field>
        <Button size="sm" onClick={() => void capitalise()}>Capitalise</Button>
      </div>
    </div>
  );
}

function InUseActions({ d, onDone, onClose }: { d: AssetDetail; onDone: () => void; onClose: () => void }) {
  const a = d.asset;
  const [v, setV] = useState({ date: today(), found: true, condition: 'good', location: a.location ?? '', notes: '' });
  const [s, setS] = useState({ kind: 'sold' as 'sold' | 'scrapped', date: today(), customerId: '', sale: 0, rate: 18 });
  const advice = useApi(() => fixedAssets.saleAdvice(a.id, s.date), [a.id, s.date]);
  const [busy, setBusy] = useState(false);

  const verify = async () => {
    try {
      await fixedAssets.act({ action: 'verify', id: a.id, date: v.date, found: v.found, condition: v.found ? v.condition : null, location: v.location || null, notes: v.notes || null });
      toast.success(v.found ? 'Verified' : 'Recorded as not found');
      onDone();
    } catch (e) {
      toast.error('Not recorded', { description: err(e) });
    }
  };
  const tax = Math.round((s.sale * s.rate) / 100);
  const minimum = advice.data?.minimumTaxPaise ?? 0;
  const dispose = async () => {
    const msg = s.kind === 'sold'
      ? `Sell ${a.name}? An invoice is raised to the buyer, depreciation is charged to the day before, and the gain or loss is posted.`
      : `Scrap ${a.name}? Depreciation is charged to the day before, and what is left of its cost is written off.`;
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      const r = await fixedAssets.act<{ invoiceNumber: string | null; gainPaise: number; shortTaxPaise: number }>({
        action: 'dispose', id: a.id, date: s.date, kind: s.kind,
        customerId: s.kind === 'sold' ? s.customerId : null, salePaise: s.kind === 'sold' ? s.sale : null, gstRatePct: s.kind === 'sold' ? s.rate : null,
      });
      toast.success(`${s.kind === 'sold' ? `Sold${r.invoiceNumber ? ` by ${r.invoiceNumber}` : ''}` : 'Scrapped'}: ${r.gainPaise >= 0 ? 'gain' : 'loss'} ₹${(Math.abs(r.gainPaise) / 100).toLocaleString('en-IN')}`, {
        description: r.shortTaxPaise > 0 ? `GST on the invoice is ₹${(r.shortTaxPaise / 100).toLocaleString('en-IN')} below the minimum under section 18(6); pay the difference in GSTR-3B.` : undefined,
      });
      onDone();
      onClose();
    } catch (e) {
      toast.error('Not done', { description: err(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-md border p-3">
        <p className="text-sm font-medium">Physical verification</p>
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Checked on"><Input type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></Field>
          <Field label="Found?">
            <Select value={v.found ? 'yes' : 'no'} onValueChange={(x) => setV({ ...v, found: x === 'yes' })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="yes">Found</SelectItem><SelectItem value="no">Not found</SelectItem></SelectContent>
            </Select>
          </Field>
          {v.found && (
            <Field label="Condition">
              <Select value={v.condition} onValueChange={(x) => setV({ ...v, condition: x })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="good">Good</SelectItem><SelectItem value="needs_repair">Needs repair</SelectItem><SelectItem value="unusable">Unusable</SelectItem></SelectContent>
              </Select>
            </Field>
          )}
          <Field label="Where"><Input value={v.location} onChange={(e) => setV({ ...v, location: e.target.value })} /></Field>
          <Field label="Notes" className="sm:col-span-2"><Input value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
        </div>
        <div className="flex justify-end"><Button size="sm" variant="outline" onClick={() => void verify()}>Record check</Button></div>
      </div>

      <div className="space-y-2 rounded-md border border-destructive/30 p-3">
        <p className="text-sm font-medium">Sell or scrap</p>
        <div className="flex rounded-md border p-0.5 text-xs">
          {(['sold', 'scrapped'] as const).map((k) => (
            <button key={k} type="button" onClick={() => setS({ ...s, kind: k })}
              className={`flex-1 rounded px-2.5 py-1 ${s.kind === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>{k === 'sold' ? 'Sold' : 'Scrapped, nothing received'}</button>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Date"><Input type="date" value={s.date} onChange={(e) => setS({ ...s, date: e.target.value })} /></Field>
          {s.kind === 'sold' && (
            <>
              <Field label="Buyer"><ContactPicker kind="customer" value={s.customerId} onChange={(x) => setS({ ...s, customerId: x })} /></Field>
              <Field label="Sale value before GST"><MoneyInput valuePaise={s.sale} onChangePaise={(p) => setS({ ...s, sale: p })} /></Field>
              <Field label="GST rate %"><Input type="number" min={0} max={40} value={s.rate} onChange={(e) => setS({ ...s, rate: Number(e.target.value) })} /></Field>
            </>
          )}
        </div>
        {s.kind === 'sold' && minimum > 0 && (
          <p className={`text-xs ${tax < minimum ? 'text-destructive' : 'text-muted-foreground'}`}>
            Credit of <Money value={advice.data?.itcClaimedPaise ?? 0} /> was taken on it. GST on its sale must be at least <Money value={minimum} /> —
            the credit less five percentage points a quarter (section 18(6)). At {s.rate}% this sale carries <Money value={tax} />.
          </p>
        )}
        {s.kind === 'sold' && !a.hsnSac && <p className="text-xs text-destructive">Add the asset&apos;s HSN code first: the invoice needs it.</p>}
        <div className="flex justify-end">
          <Button size="sm" variant="destructive" onClick={() => void dispose()} disabled={busy || (s.kind === 'sold' && (!s.customerId || !s.sale))}>
            {busy && <Loader2 className="size-4 animate-spin" />} {s.kind === 'sold' ? 'Sell' : 'Scrap'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── A class ──────────────────────────────────────────────────────────────────

export function ClassDialog({ value, onClose, onDone }: { value: AssetClassRow | 'new' | null; onClose: () => void; onDone: () => void }) {
  const ledgers = useApi(() => accountApi.list({ type: 'asset' }), []);
  const options = (ledgers.data?.accounts ?? []).filter((a) => a.subtype === 'fixed_asset' || a.subtype === 'intangible')
    .map((a) => ({ value: a.id, label: `${a.code} ${a.name}` }));
  const blank = { name: '', accountId: '', method: 'slm' as 'slm' | 'wdv', life: 10, residual: 5, block: '', rate: 15 };
  const [f, setF] = useState(blank);
  useEffect(() => {
    if (value && value !== 'new') {
      setF({ name: value.name, accountId: value.accountId, method: value.method, life: value.usefulLifeYears, residual: value.residualPct, block: value.itBlock, rate: value.itRatePct });
    } else if (value === 'new') setF(blank);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const save = async () => {
    try {
      await fixedAssets.act({
        action: 'class', id: value && value !== 'new' ? value.id : undefined, name: f.name, accountId: f.accountId,
        method: f.method, usefulLifeYears: f.life, residualPct: f.residual, itBlock: f.block, itRatePct: f.rate,
      });
      toast.success('Class saved');
      onDone();
    } catch (e) {
      toast.error('Not saved', { description: err(e) });
    }
  };
  return (
    <Dialog open={!!value} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{value === 'new' ? 'New class of assets' : 'Class of assets'}</DialogTitle>
          <DialogDescription>A changed life or method applies to depreciation run from now on; what was posted stays.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required className="sm:col-span-2"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Ledger" required className="sm:col-span-2">
            <Combobox options={options} value={f.accountId} onChange={(v) => setF({ ...f, accountId: v })} showAvatar={false} placeholder="A fixed-asset ledger" />
          </Field>
          <Field label="Method (Companies Act)">
            <Select value={f.method} onValueChange={(v) => setF({ ...f, method: v as 'slm' | 'wdv' })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="slm">Straight line</SelectItem><SelectItem value="wdv">Written-down value</SelectItem></SelectContent>
            </Select>
          </Field>
          <Field label="Useful life, years" hint="Schedule II"><Input type="number" min={0.1} step="0.5" value={f.life} onChange={(e) => setF({ ...f, life: Number(e.target.value) })} /></Field>
          <Field label="Residual value %" hint="Usually 5"><Input type="number" min={0} max={99} value={f.residual} onChange={(e) => setF({ ...f, residual: Number(e.target.value) })} /></Field>
          <Field label="Income-tax block"><Input value={f.block} onChange={(e) => setF({ ...f, block: e.target.value })} /></Field>
          <Field label="Block rate %"><Input type="number" min={0} max={100} value={f.rate} onChange={(e) => setF({ ...f, rate: Number(e.target.value) })} /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={!f.name || !f.accountId || !f.block}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
