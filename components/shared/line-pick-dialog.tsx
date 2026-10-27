'use client';

// Take an order, a challan or a receipt note one step further: some lines, or
// part of a line. Each line shows what is left on it, and the quantity starts
// at that, so taking everything is one click and taking part is a number.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MoneyInput } from '@/components/shared/form-bits';
import { orderFlow, type LinePick, type OrderDoc, type OrderLine } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

export function LinePickDialog({
  open, onClose, title, description, doc, docId, use, editRate = false, submitLabel, header, canSubmit = true, onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  doc: OrderDoc;
  docId: string | null;
  /** Which remainder the step works from: what is left to invoice/bill, or to deliver/receive. */
  use: 'invoice' | 'move';
  /** Let the supplier's price be entered per line (bills). */
  editRate?: boolean;
  submitLabel: string;
  /** The step's own fields: dates, the supplier's number and so on. */
  header?: ReactNode;
  canSubmit?: boolean;
  onSubmit: (picks: LinePick[]) => Promise<void>;
}) {
  const state = useApi<{ lines: OrderLine[] }>(
    () => (open && docId ? orderFlow.lines(doc, docId) : Promise.resolve({ lines: [] })),
    [open, doc, docId],
  );
  const left = (l: OrderLine) => Math.max(0, use === 'invoice' ? l.toInvoice : (l.toMove ?? 0));
  const lines = useMemo(() => state.data?.lines ?? [], [state.data]);

  const [qty, setQty] = useState<Record<string, string>>({});
  const [rate, setRate] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setQty(Object.fromEntries(lines.map((l) => [l.id, String(left(l))])));
    setRate(Object.fromEntries(lines.map((l) => [l.id, l.ratePaise])));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the lines load
  }, [lines]);

  const picks: LinePick[] = lines
    .map((l) => ({ l, q: Number(qty[l.id] ?? 0) }))
    .filter(({ q }) => q > 0)
    .map(({ l, q }) => ({ lineId: l.id, qty: q, ...(editRate && rate[l.id] !== l.ratePaise ? { ratePaise: rate[l.id] } : {}) }));
  const tooMuch = lines.some((l) => Number(qty[l.id] ?? 0) > left(l) + 1e-9);
  const nothingLeft = lines.length > 0 && lines.every((l) => left(l) <= 0);

  const submit = async () => {
    setBusy(true);
    try {
      await onSubmit(picks);
      onClose();
    } catch (e) {
      toast.error('Could not do that', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {header && <div className="grid gap-3 sm:grid-cols-3">{header}</div>}
        {state.loading ? (
          <p className="py-4 text-sm text-muted-foreground">Loading lines…</p>
        ) : state.error ? (
          <p className="py-4 text-sm text-destructive">{state.error}</p>
        ) : nothingLeft ? (
          <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">Nothing is left on it.</p>
        ) : (
          <div className="max-h-80 overflow-y-auto rounded-md border thin-scroll">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 text-left font-semibold">Line</th>
                  <th className="px-3 py-2 text-right font-semibold">Ordered</th>
                  <th className="px-3 py-2 text-right font-semibold">Left</th>
                  <th className="w-28 px-3 py-2 text-right font-semibold">This time</th>
                  {editRate && <th className="w-36 px-3 py-2 text-right font-semibold">Rate</th>}
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const over = Number(qty[l.id] ?? 0) > left(l) + 1e-9;
                  return (
                    <tr key={l.id} className={`border-b last:border-0 ${left(l) <= 0 ? 'opacity-50' : ''}`}>
                      <td className="px-3 py-2">
                        <span className="text-xs text-muted-foreground">{l.lineNo}.</span> {l.description ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{l.qty} {l.uqc ?? ''}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{left(l)}</td>
                      <td className="px-3 py-1.5">
                        <Input
                          type="number" min={0} step="any" value={qty[l.id] ?? ''} disabled={left(l) <= 0}
                          onChange={(e) => setQty((x) => ({ ...x, [l.id]: e.target.value }))}
                          className={`h-8 text-right ${over ? 'border-destructive' : ''}`}
                        />
                      </td>
                      {editRate && (
                        <td className="px-3 py-1.5">
                          <MoneyInput valuePaise={rate[l.id] ?? 0} onChangePaise={(p) => setRate((x) => ({ ...x, [l.id]: p }))} className="h-8" />
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {tooMuch && <p className="text-xs text-destructive">A quantity is more than is left on its line.</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy || !canSubmit || tooMuch || picks.length === 0} className="gap-1.5">
            {busy && <Loader2 className="size-4 animate-spin" />} {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
