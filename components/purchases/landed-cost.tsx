'use client';

// Landed cost on a bill, as Zoho Books has it: freight, duty or clearing from
// another bill (or a freight line on this one) spread over this bill's goods,
// by quantity, by value or by hand, into their stock value. Shown on a bill
// with stock lines; each line's cost per unit includes what it carries.

import { useMemo, useState } from 'react';
import { Loader2, Plus, Trash2, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Money } from '@/components/shared/money';
import { Field } from '@/components/shared/form-bits';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { formatINR } from '@/lib/money';

type Method = 'quantity' | 'value' | 'manual';
interface Goods { lineId: string; item: string; qty: number; uqc: string | null; valuePaise: number; landedPaise: number; unitCostPaise: number }
interface Charge { lineId: string; billId: string; bill: string; vendor: string; date: string; description: string | null; account: string | null; costPaise: number; leftPaise: number }
interface Allocation {
  id: string; method: Method; amountPaise: number; date: string; posted: boolean;
  charge: { billId: string; bill: string; vendor: string; description: string | null }; lines: { lineId: string; amountPaise: number }[];
}
interface Data { goods: Goods[]; allocations: Allocation[]; charges: Charge[] }

const METHOD: Record<Method, string> = { quantity: 'By quantity', value: 'By value', manual: 'By hand' };

/** The same split the server makes, for the preview: to the paisa, remainder to the largest shares. */
function split(total: number, weights: number[]) {
  const sum = weights.reduce((t, w) => t + w, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((t, n) => t + n, 0);
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (let k = 0; left > 0; k++, left--) out[order[k % order.length].i] += 1;
  return out;
}

export function LandedCostCard({ billId, canEdit }: { billId: string; canEdit: boolean }) {
  const state = useApi<Data>(() => api.get('/api/landed-costs', { billId }), [billId]);
  const [busy, setBusy] = useState(false);
  const d = state.data;
  if (!d || d.goods.length === 0) return null;
  const carried = d.allocations.reduce((t, a) => t + a.amountPaise, 0);

  const remove = async (a: Allocation) => {
    if (!window.confirm(`Take the ${formatINR(a.amountPaise)} landed cost from ${a.charge.vendor} off these goods?`)) return;
    setBusy(true);
    try {
      await api.post('/api/landed-costs', { action: 'remove', id: a.id });
      toast.success('Landed cost taken off');
      await state.refetch();
    } catch (e) {
      toast.error('Not done', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-3 p-5" data-slot="landed-cost">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold"><Truck className="size-4" /> Landed cost</h3>
          <p className="text-xs text-muted-foreground">Freight, duty or clearing spread over these goods, into their stock value. {carried ? `${formatINR(carried)} carried.` : ''}</p>
        </div>
        {canEdit && <AllocateDialog billId={billId} data={d} onDone={() => void state.refetch()} />}
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
            <th className="py-1 font-semibold">Item</th><th className="py-1 text-right font-semibold">Qty</th>
            <th className="py-1 text-right font-semibold">Value</th><th className="py-1 text-right font-semibold">Landed cost</th>
            <th className="py-1 text-right font-semibold">Cost per unit</th>
          </tr>
        </thead>
        <tbody>
          {d.goods.map((g) => (
            <tr key={g.lineId} className="border-t">
              <td className="py-1.5">{g.item}</td>
              <td className="py-1.5 text-right tabular-nums">{g.qty} {g.uqc ?? ''}</td>
              <td className="py-1.5 text-right"><Money value={g.valuePaise} /></td>
              <td className="py-1.5 text-right"><Money value={g.landedPaise} showZero={false} /></td>
              <td className="py-1.5 text-right font-medium" data-slot="unit-cost"><Money value={g.unitCostPaise} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {d.allocations.length > 0 && (
        <ul className="divide-y rounded-md border text-sm" data-slot="landed-cost-list">
          {d.allocations.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{a.charge.description || 'Charge'}</span>
                <span className="block text-xs text-muted-foreground">{a.charge.vendor} · bill {a.charge.bill} · {METHOD[a.method].toLowerCase()} · from {a.date}{a.posted ? ' · moved into Inventory' : ''}</span>
              </span>
              <Money value={a.amountPaise} className="font-medium" />
              {canEdit && <Button size="icon" variant="ghost" className="size-7" disabled={busy} onClick={() => void remove(a)} aria-label="Take it off"><Trash2 className="size-3.5" /></Button>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function AllocateDialog({ billId, data, onDone }: { billId: string; data: Data; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [chargeId, setChargeId] = useState('');
  const [method, setMethod] = useState<Method>('quantity');
  const [amount, setAmount] = useState('');
  const [manual, setManual] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const charge = data.charges.find((c) => c.lineId === chargeId);
  const amountPaise = Math.round(Number(amount || 0) * 100);
  const shares = useMemo(() => {
    if (method === 'manual') return data.goods.map((g) => Math.round(Number(manual[g.lineId] || 0) * 100));
    return split(amountPaise, data.goods.map((g) => (method === 'quantity' ? g.qty : g.valuePaise)));
  }, [method, amountPaise, manual, data.goods]);
  const total = shares.reduce((t, n) => t + n, 0);
  const over = !!charge && total > charge.leftPaise;

  const save = async () => {
    setBusy(true);
    try {
      await api.post('/api/landed-costs', {
        action: 'allocate', goodsBillId: billId, chargeLineId: chargeId, method,
        ...(method === 'manual' ? { manual: data.goods.map((g, i) => ({ lineId: g.lineId, amountPaise: shares[i] })) } : { amountPaise }),
      });
      toast.success(`${formatINR(total)} spread over the goods`, { description: 'Their stock value and cost per unit now include it.' });
      setOpen(false);
      setChargeId(''); setAmount(''); setManual({});
      onDone();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5" data-slot="add-landed-cost"><Plus className="size-3.5" /> Add landed cost</Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add landed cost</DialogTitle>
          <DialogDescription>Choose a charge — a line with no item on a bill, such as freight or customs clearing — and spread it over these goods.</DialogDescription>
        </DialogHeader>
        {data.charges.length === 0 ? (
          <p className="text-sm text-muted-foreground">No charge has anything left to spread. Record the transporter’s or clearing agent’s bill first, with the charge as a line with no item.</p>
        ) : (
          <div className="space-y-3">
            <Field label="Charge">
              <select value={chargeId} aria-label="Charge" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                onChange={(e) => { setChargeId(e.target.value); const c = data.charges.find((x) => x.lineId === e.target.value); setAmount(c ? (c.leftPaise / 100).toFixed(2) : ''); }}>
                <option value="">Choose…</option>
                {data.charges.map((c) => (
                  <option key={c.lineId} value={c.lineId}>{c.description || c.account || 'Charge'} — {c.vendor}, bill {c.bill}, {c.date}: {formatINR(c.leftPaise)} left</option>
                ))}
              </select>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Spread">
                <select value={method} onChange={(e) => setMethod(e.target.value as Method)} aria-label="Spread" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                  {(Object.keys(METHOD) as Method[]).map((m) => <option key={m} value={m}>{METHOD[m]}</option>)}
                </select>
              </Field>
              {method !== 'manual' && (
                <Field label="Amount (₹)" hint={charge ? `Up to ${formatINR(charge.leftPaise)}` : undefined}>
                  <Input type="number" step="0.01" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount" />
                </Field>
              )}
            </div>
            <table className="w-full text-sm" data-slot="landed-preview">
              <thead><tr className="text-left text-[10px] uppercase tracking-[0.08em] text-muted-foreground"><th className="py-1">Item</th><th className="py-1 text-right">Qty</th><th className="py-1 text-right">Value</th><th className="py-1 text-right">Share</th></tr></thead>
              <tbody>
                {data.goods.map((g, i) => (
                  <tr key={g.lineId} className="border-t">
                    <td className="py-1.5">{g.item}</td>
                    <td className="py-1.5 text-right tabular-nums">{g.qty}</td>
                    <td className="py-1.5 text-right"><Money value={g.valuePaise} /></td>
                    <td className="py-1.5 text-right">
                      {method === 'manual'
                        ? <Input type="number" step="0.01" min={0} className="ml-auto h-8 w-28 text-right" aria-label={`Share for ${g.item}`}
                            value={manual[g.lineId] ?? ''} onChange={(e) => setManual({ ...manual, [g.lineId]: e.target.value })} />
                        : <Money value={shares[i]} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className={`text-right text-sm ${over ? 'text-destructive' : 'text-muted-foreground'}`}>
              {formatINR(total)} in all{over && charge ? `: more than the ${formatINR(charge.leftPaise)} left of the charge` : ''}
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={!charge || total <= 0 || over || busy} onClick={() => void save()} data-slot="save-landed-cost">
            {busy && <Loader2 className="size-3.5 animate-spin" />} Spread {formatINR(total)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
