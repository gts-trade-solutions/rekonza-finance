'use client';

// The filing bar on every return screen (GSTR-1, IFF, GSTR-3B, GSTR-7,
// GSTR-8, GSTR-9, GSTR-9C) and in the return status grid.
//
// It says, in one place: filed or not, when it was due, how late it is and
// what that costs (late fee and interest, worked out the way the portal will),
// whether a GST Suvidha Provider is set up on this server to file through —
// and, when one is not, plainly that the return is uploaded by hand on
// gst.gov.in, with the steps. Filing needs a GSP contract and the authorised
// signatory's OTP; nothing here pretends to file.
//
// The filed mark (date and ARN) has worded Edit and Delete buttons, as the
// client asked for every record a person makes. Marking a return filed can
// lock its period, so a document dated in it cannot be changed behind the
// filed return: the same lock as Settings → Transaction locking.

import { useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, CloudOff, FileCheck2, Lock, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EditButton, DeleteButton, useConfirmDelete } from '@/components/shared/row-actions';
import { Money } from '@/components/shared/money';
import { api, ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';
import type { FilingReturn } from '@/lib/gst/filing';

export interface FilingStatusView {
  returnType: FilingReturn;
  title: string;
  period: string;
  periodLabel: string;
  periodEnd: string;
  dueDate: string;
  status: 'filed' | 'filed_late' | 'overdue' | 'due_soon' | 'upcoming';
  daysLate: number;
  filed: { on: string; arn: string | null; note: string | null; by: string | null } | null;
  estimate: { lateFeeCgstPaise: number; lateFeeSgstPaise: number; interestPaise: number; basis: string };
  gsp: { configured: boolean; returnsSupported: boolean; missing: string[]; label: string };
  locks: { sales: string | null; purchases: string | null };
  suggestedLocks: ('sales' | 'purchases')[];
  offlineSteps: string[];
  href: string;
}

const longDay = (iso: string | null | undefined) =>
  iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const FILING_LOOK: Record<FilingStatusView['status'], { label: string; cls: string }> = {
  filed: { label: 'Filed', cls: 'border-emerald-500/40 bg-emerald-50 text-emerald-800' },
  filed_late: { label: 'Filed late', cls: 'border-amber-500/40 bg-amber-50 text-amber-800' },
  overdue: { label: 'Overdue', cls: 'border-red-500/40 bg-red-50 text-red-700' },
  due_soon: { label: 'Due soon', cls: 'border-amber-500/40 bg-amber-50 text-amber-800' },
  upcoming: { label: 'Not filed', cls: 'border-border bg-muted/40 text-muted-foreground' },
};

/** Mark filed, or change the mark: the date, the ARN, and the lock after filing. */
export function FilingDialog({ s, onClose, onDone }: { s: FilingStatusView; onClose: () => void; onDone: () => void }) {
  const [filedOn, setFiledOn] = useState(s.filed?.on ?? localToday());
  const [arn, setArn] = useState(s.filed?.arn ?? '');
  const [note, setNote] = useState(s.filed?.note ?? '');
  // Offered only where the lock would move forward.
  const lockable = s.suggestedLocks.filter((m) => !s.locks[m] || s.locks[m]! < s.periodEnd);
  const [lock, setLock] = useState<('sales' | 'purchases')[]>(s.filed ? [] : lockable);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ arn: string; kept: number; locked: { module: string; lockedUpto: string }[] }>('/api/gst/filing', {
        action: 'file', returnType: s.returnType, period: s.period, filedOn, arn: arn.trim(), note: note.trim() || null, lock,
      });
      toast.success(`${s.title} for ${s.periodLabel} marked as filed`, {
        description: [
          `ARN ${r.arn}.`,
          r.kept ? `${r.kept} document(s) kept as filed: a later change shows as an amendment.` : '',
          r.locked.length ? `Locked ${r.locked.map((l) => `${l.module} up to ${longDay(l.lockedUpto)}`).join(' and ')}.` : '',
        ].filter(Boolean).join(' '),
      });
      onDone();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-md" data-slot="filing-dialog">
        <DialogHeader>
          <DialogTitle>{s.filed ? 'Change the filed mark' : 'Mark as filed'}: {s.title} · {s.periodLabel}</DialogTitle>
          <DialogDescription>
            Enter what the GST portal showed after filing. Due {longDay(s.dueDate)}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="filing-date">Date of filing</Label>
            <Input id="filing-date" type="date" value={filedOn} max={localToday()} onChange={(e) => setFiledOn(e.target.value)} data-slot="filing-date" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="filing-arn">ARN</Label>
            <Input id="filing-arn" value={arn} onChange={(e) => setArn(e.target.value.toUpperCase().replace(/\s/g, ''))} maxLength={20}
              placeholder="AA3310260123456" className="font-mono" data-slot="filing-arn" />
            <p className="text-xs text-muted-foreground">The acknowledgement reference number on the filing confirmation.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="filing-note">Note (optional)</Label>
            <Input id="filing-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Filed with EVC by the accountant" data-slot="filing-note" />
          </div>
          {lockable.length > 0 && (
            <div className="space-y-1.5 rounded-md border bg-muted/30 p-3" data-slot="filing-lock">
              <p className="flex items-center gap-1.5 text-xs font-medium"><Lock className="size-3.5" /> Lock the period after filing</p>
              {lockable.map((m) => (
                <label key={m} className="flex items-center gap-2 text-[13px]">
                  <Checkbox checked={lock.includes(m)} onCheckedChange={(v) => setLock((l) => (v === true ? [...l, m] : l.filter((x) => x !== m)))} data-slot={`filing-lock-${m}`} />
                  {m === 'sales' ? 'Sales' : 'Purchases'}: nothing dated up to {longDay(s.periodEnd)} can be added, changed or deleted
                </label>
              ))}
              <p className="text-[11px] text-muted-foreground">A correction after that goes in the next return. The lock can be lifted in Settings → Transaction locking (it is recorded in the audit trail).</p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !filedOn || arn.trim().length < 10} data-slot="filing-save">
            {busy ? 'Saving…' : s.filed ? 'Save' : 'Mark as filed'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The steps for uploading the return by hand on gst.gov.in. */
export function OfflineSteps({ s, open: initiallyOpen = false }: { s: FilingStatusView; open?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const viaGsp = s.gsp.configured && s.gsp.returnsSupported;
  return (
    <div className="rounded-md border bg-muted/20 text-xs" data-slot="filing-offline">
      <button type="button" className="flex w-full items-start gap-2 px-3 py-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {viaGsp ? <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-600" /> : <CloudOff className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1" data-slot="filing-gsp-status">
          {viaGsp
            ? <>A GST Suvidha Provider is set up on this server ({s.gsp.label}): push and file from the GST portal panel. You can still upload by hand.</>
            : <><b>No GSP is connected on this server, so Rekonza does not file this return itself.</b> Download the JSON and upload it on gst.gov.in → Returns → Offline upload.
              {!s.gsp.returnsSupported ? ' (A GSP connection files GSTR-1, IFF and GSTR-3B; this return is always uploaded by hand.)' : s.gsp.missing.length ? ` Not set up: ${s.gsp.missing.join(', ')}.` : ''}</>}
        </span>
        {open ? <ChevronDown className="mt-0.5 size-3.5 shrink-0" /> : <ChevronRight className="mt-0.5 size-3.5 shrink-0" />}
        <span className="sr-only">How to file</span>
      </button>
      {open && (
        <ol className="list-decimal space-y-1 border-t px-3 py-2 pl-8 leading-relaxed text-muted-foreground" data-slot="filing-steps">
          {s.offlineSteps.map((t) => <li key={t}>{t}</li>)}
        </ol>
      )}
    </div>
  );
}

/** Late fee and interest, while overdue or as filed late. */
function Estimate({ s }: { s: FilingStatusView }) {
  const fee = s.estimate.lateFeeCgstPaise + s.estimate.lateFeeSgstPaise;
  if (s.daysLate <= 0 && !fee && !s.estimate.interestPaise) return null;
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-1 rounded-md border border-amber-500/30 bg-amber-50/60 px-3 py-2 text-xs" data-slot="filing-estimate">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
      <span>{s.daysLate} day{s.daysLate === 1 ? '' : 's'} late</span>
      <span>Late fee <Money value={fee} /> (CGST <Money value={s.estimate.lateFeeCgstPaise} /> + SGST <Money value={s.estimate.lateFeeSgstPaise} />)</span>
      <span>Interest <Money value={s.estimate.interestPaise} /></span>
      <span className="basis-full text-muted-foreground">{s.estimate.basis}</span>
    </div>
  );
}

/** The bar itself. `payableCashPaise` is not needed: the server works the interest out per return. */
export function ReturnFilingBar({ returnType, period, title, onChange }: {
  returnType: FilingReturn; period: string; title?: string; payableCashPaise?: number; onChange?: () => void;
}) {
  const state = useApi<FilingStatusView>(() => api.get('/api/gst/filing', { returnType, period }), [returnType, period]);
  const canEdit = usePermission('gst', 'edit');
  const [editing, setEditing] = useState(false);
  const confirm = useConfirmDelete();
  const s = state.data;
  if (!s) return state.error ? <p className="text-xs text-destructive" data-slot="return-filing-error">{state.error}</p> : null;
  const look = FILING_LOOK[s.status];
  const done = () => { setEditing(false); void state.refetch(); onChange?.(); };
  const unfile = () => confirm.ask({
    title: `Delete the filed mark on ${s.title} for ${s.periodLabel}?`,
    description: 'The return shows as not filed here again, and its documents are no longer kept as filed. Nothing on the GST portal changes: a return filed there stays filed. A lock set with it stays until lifted in Settings → Transaction locking.',
    confirmLabel: 'Delete the mark',
    run: (reason) => api.post('/api/gst/filing', { action: 'unfile', returnType: s.returnType, period: s.period, reason }),
    done: 'Filed mark deleted', onDone: done,
  });
  const lockedTo = s.suggestedLocks.map((m) => (s.locks[m] && s.locks[m]! >= s.periodEnd ? m : null)).filter(Boolean);

  return (
    <Card className="space-y-2.5 p-4 print:hidden" data-slot="return-filing-bar" data-status={s.status}>
      <div className="flex flex-wrap items-center gap-2">
        <FileCheck2 className="size-4 text-primary" />
        <span className="text-sm font-semibold">Filing · {title ?? s.title} · {s.periodLabel}</span>
        <Badge variant="outline" className={cn('gap-1 text-[11px]', look.cls)} data-slot="filing-status">
          {(s.status === 'filed' || s.status === 'filed_late') && <CheckCircle2 className="size-3" />} {look.label}
        </Badge>
        <span className="text-xs text-muted-foreground">Due {longDay(s.dueDate)}</span>
        {lockedTo.length > 0 && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground" data-slot="filing-locked"><Lock className="size-3" /> {lockedTo.join(' and ')} locked to {longDay(s.periodEnd)}</span>
        )}
        <span className="flex-1" />
        {!s.filed && canEdit && (
          <Button size="sm" onClick={() => setEditing(true)} data-slot="filing-mark">Mark as filed</Button>
        )}
      </div>

      {s.filed && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs" data-slot="filing-filed">
          <span>Filed on <b>{longDay(s.filed.on)}</b></span>
          {s.filed.arn && <span>ARN <span className="font-mono" data-slot="filing-filed-arn">{s.filed.arn}</span></span>}
          {s.filed.by && <span className="text-muted-foreground">marked by {s.filed.by}</span>}
          {s.filed.note && <span className="text-muted-foreground">· {s.filed.note}</span>}
          {canEdit && (
            <span className="ml-auto flex gap-1.5">
              <EditButton onClick={() => setEditing(true)} slot="filing-edit" title="Change the date filed or the ARN" />
              <DeleteButton onClick={unfile} slot="filing-delete" title="Take the filed mark off" />
            </span>
          )}
        </div>
      )}

      <Estimate s={s} />
      <OfflineSteps s={s} open={!s.filed} />
      <p className="text-[11px] text-muted-foreground">
        Every return&apos;s status, filed or not, is on <Link href="/gst/return-status" className="text-primary hover:underline">Return Status</Link>.
      </p>

      {editing && <FilingDialog s={s} onClose={() => setEditing(false)} onDone={done} />}
      {confirm.dialog}
    </Card>
  );
}
