'use client';

// After matching a bill with GSTR-2B: when its credit is taken.
//
//   Accept       claim it in the bill's own month (the default)
//   Defer        hold it back until the supplier files it
//   Claim later  claim it in a named later month, the one whose GSTR-2B has it
//
// Since 1 January 2022 credit may be taken only on what GSTR-2B shows (CGST
// Act s.16(2)(aa)), so a bill the supplier has not filed is usually deferred,
// and claimed later when it appears. GSTR-3B 4(A)(5) follows the decision
// (lib/server/gst/itc-claims.ts); a decision that would change a GSTR-3B
// already filed is refused.

import { useState } from 'react';
import { CalendarClock, Check, Loader2, PauseCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Money } from '@/components/shared/money';
import { EditButton, DeleteButton, useConfirmDelete } from '@/components/shared/row-actions';
import { gstReturns, ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { periodLabel } from '@/lib/gst/filing';

export interface ClaimOnRow { decision: 'accept' | 'defer' | 'claim_later'; claimPeriod: string | null; note: string | null; by: string | null }

const nextMonth = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
};

/** Claim later: the month, and why. */
function LaterDialog({ billIds, label, from, current, onClose, onDone }: {
  billIds: string[]; label: string; from: string; current?: ClaimOnRow | null; onClose: () => void; onDone: () => void;
}) {
  const [month, setMonth] = useState(current?.claimPeriod ?? nextMonth(from));
  const [note, setNote] = useState(current?.note ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await gstReturns.setClaim({ billIds, decision: 'claim_later', claimPeriod: month, note: note.trim() || null });
      toast.success(`Credit on ${label} to be claimed in ${periodLabel(month)}`, { description: 'GSTR-3B for that month carries it in 4(A)(5).' });
      onDone();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-sm" data-slot="itc-claim-later-dialog">
        <DialogHeader>
          <DialogTitle>Claim the credit later: {label}</DialogTitle>
          <DialogDescription>The month whose GSTR-2B carries the supplier&apos;s invoice. No later than 30 November after the year ends (section 16(4)).</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label htmlFor="claim-month">Claim in</Label><Input id="claim-month" type="month" value={month} min={nextMonth(from)} onChange={(e) => setMonth(e.target.value)} data-slot="itc-claim-month" /></div>
          <div className="space-y-1.5"><Label htmlFor="claim-note">Why (optional)</Label><Input id="claim-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Supplier filed late; in next month's 2B" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !month} data-slot="itc-claim-later-save">{busy && <Loader2 className="size-3.5 animate-spin" />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ClaimBadge({ claim }: { claim: ClaimOnRow | null | undefined }) {
  if (!claim || claim.decision === 'accept') return <Badge variant="outline" className="border-emerald-500/40 text-[10px] text-emerald-700" data-slot="itc-claim-badge" data-decision="accept">Claimed in its month</Badge>;
  if (claim.decision === 'defer') return <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-800" data-slot="itc-claim-badge" data-decision="defer">Deferred</Badge>;
  return <Badge variant="outline" className="border-sky-500/40 text-[10px] text-sky-800" data-slot="itc-claim-badge" data-decision="claim_later">Claim in {claim.claimPeriod ? periodLabel(claim.claimPeriod) : '—'}</Badge>;
}

/** The three actions, worded, on one of our bills. */
export function ClaimActions({ billId, billNo, billMonth, claim, onDone }: {
  billId: string; billNo: string; billMonth: string; claim: ClaimOnRow | null | undefined; onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [later, setLater] = useState(false);
  const set = async (decision: 'accept' | 'defer') => {
    setBusy(true);
    try {
      await gstReturns.setClaim({ billIds: [billId], decision });
      toast.success(decision === 'accept' ? `Credit on ${billNo} claimed in its own month` : `Credit on ${billNo} held back until the supplier files`);
      onDone();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const d = claim?.decision ?? 'accept';
  return (
    <span className="flex flex-wrap items-center gap-1" data-slot="itc-claim-actions">
      <ClaimBadge claim={claim} />
      {d !== 'accept' && <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[11px]" disabled={busy} onClick={() => void set('accept')} data-slot="itc-claim-accept"><Check className="size-3" /> Accept</Button>}
      {d !== 'defer' && <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[11px]" disabled={busy} onClick={() => void set('defer')} data-slot="itc-claim-defer"><PauseCircle className="size-3" /> Defer</Button>}
      <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[11px]" disabled={busy} onClick={() => setLater(true)} data-slot="itc-claim-later"><CalendarClock className="size-3" /> Claim later</Button>
      {later && <LaterDialog billIds={[billId]} label={billNo} from={billMonth} current={claim} onClose={() => setLater(false)} onDone={() => { setLater(false); onDone(); }} />}
    </span>
  );
}

/** Every bill whose credit is held back or moved, whatever its month: Edit and Delete each decision. */
export function HeldBackCard({ period, onChange, version = 0 }: {
  period: string; onChange: () => void;
  /** Bumped by the page when a bill's decision changes on a row above, so this card reads it again. */
  version?: number;
}) {
  const state = useApi(() => gstReturns.itcClaims(period), [period, version]);
  const del = useConfirmDelete();
  const [editing, setEditing] = useState<{ billId: string; number: string; billDate: string; claim: ClaimOnRow } | null>(null);
  const d = state.data;
  if (!d) return null;
  const refresh = () => { void state.refetch(); onChange(); };
  return (
    <Card className="space-y-2 p-4" data-slot="itc-held-back">
      <div className="flex flex-wrap items-baseline gap-2">
        <p className="text-sm font-semibold">Credit held back or claimed later ({d.decisions.length})</p>
        <p className="text-xs text-muted-foreground">Decisions made after matching, across every month. Delete a decision to claim the bill in its own month again.</p>
      </div>
      {d.shifts.length > 0 && (
        <p className="text-xs" data-slot="itc-shifts">
          GSTR-3B for {periodLabel(period)}: {d.shifts.filter((s) => s.direction === 'in').length} bill(s) claimed now from earlier months,
          {' '}{d.shifts.filter((s) => s.direction === 'out').length} of this month held back.
        </p>
      )}
      {d.decisions.length === 0 ? (
        <p className="text-xs text-muted-foreground">None: every bill&apos;s credit is claimed in its own month. Use Defer or Claim later on a bill above when its supplier has not filed it.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[760px] text-sm">
            <thead><tr className="border-b bg-muted/50 text-[10px] uppercase tracking-wide text-muted-foreground">
              {['Bill', 'Supplier', 'Bill date', 'Tax', 'Decision', 'By', ''].map((h) => <th key={h} className="px-3 py-2 text-left font-semibold">{h}</th>)}
            </tr></thead>
            <tbody>
              {d.decisions.map((x) => (
                <tr key={x.billId} className="border-b last:border-0" data-slot="itc-held-row">
                  <td className="px-3 py-2"><a href={`/purchases/bills/${x.billId}`} className="text-primary hover:underline">{x.number}</a>{x.vendorInvoiceNo && <span className="ml-1 text-xs text-muted-foreground">({x.vendorInvoiceNo})</span>}</td>
                  <td className="px-3 py-2 text-xs">{x.party}</td>
                  <td className="px-3 py-2 text-xs">{x.billDate}</td>
                  <td className="px-3 py-2 text-right"><Money value={x.taxPaise} /></td>
                  <td className="px-3 py-2"><ClaimBadge claim={x} />{x.note && <span className="block text-[11px] text-muted-foreground">{x.note}</span>}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{x.by ?? '—'}</td>
                  <td className="px-3 py-2">
                    <span className="flex gap-1.5">
                      <EditButton slot="itc-held-edit" onClick={() => setEditing({ billId: x.billId, number: x.number, billDate: x.billDate, claim: x })} title="Change the month it is claimed in" />
                      <DeleteButton slot="itc-held-delete" onClick={() => del.ask({
                        title: `Delete the decision on ${x.number}?`,
                        description: 'Its credit counts in its own month again (GSTR-3B 4(A)(5) of the bill\'s month). Refused if that month\'s GSTR-3B is filed.',
                        reason: false, confirmLabel: 'Delete the decision',
                        run: () => gstReturns.setClaim({ billIds: [x.billId], decision: 'accept' }), done: 'Decision deleted', onDone: refresh,
                      })} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <LaterDialog billIds={[editing.billId]} label={editing.number} from={editing.billDate.slice(0, 7)} current={editing.claim} onClose={() => setEditing(null)} onDone={() => { setEditing(null); refresh(); }} />}
      {del.dialog}
    </Card>
  );
}
