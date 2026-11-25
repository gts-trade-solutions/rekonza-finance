'use client';

// Edit and Delete as buttons a person can see, with words on them.
//
// The client tests the live site looking for "Edit" and "Delete" (2026-11-25:
// "wherever we need edit and delete you should give"), and did not recognise a
// ⋯ menu or a bare pencil and bin as edit and delete. So every list of things a
// person made carries these two buttons, text and icon, in the style of the
// General Ledger's row actions (components/reports/ledger-entry-actions.tsx).
//
// Delete always asks first. The dialog can take a reason, sent as ?reason= on
// the DELETE (the server counts it towards a book that keeps a reason with
// every change, so nobody is asked twice). When the server refuses — the record
// is in use, the books forbid it — the refusal shows in a toast and in the
// dialog itself, with the way out the app offers instead ("Mark as inactive",
// "Set a leaving date"), as Zoho does.

import { useState, type ReactNode } from 'react';
import { Loader2, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const BTN = 'inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border bg-background px-2 text-xs font-medium hover:bg-accent disabled:pointer-events-none disabled:opacity-50';

export function EditButton({ onClick, label = 'Edit', title, disabled, className }: {
  onClick: () => void; label?: string; title?: string; disabled?: boolean; className?: string;
}) {
  return (
    <button type="button" className={cn(BTN, 'text-link', className)} data-slot="row-edit" title={title} disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onClick(); }}>
      <Pencil className="size-3.5" /> {label}
    </button>
  );
}

export function DeleteButton({ onClick, label = 'Delete', title, disabled, className }: {
  onClick: () => void; label?: string; title?: string; disabled?: boolean; className?: string;
}) {
  return (
    <button type="button" className={cn(BTN, 'text-destructive', className)} data-slot="row-delete" title={title} disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onClick(); }}>
      <Trash2 className="size-3.5" /> {label}
    </button>
  );
}

/** Edit and Delete side by side, for the last column of a row. Either can be left out. */
export function RowActions({ onEdit, onDelete, editLabel, deleteLabel, editTitle, deleteTitle, children, className }: {
  onEdit?: (() => void) | false | null; onDelete?: (() => void) | false | null;
  editLabel?: string; deleteLabel?: string; editTitle?: string; deleteTitle?: string;
  /** More buttons before Edit (Mark verified, Pay…). */
  children?: ReactNode; className?: string;
}) {
  if (!onEdit && !onDelete && !children) return null;
  return (
    <div className={cn('flex items-center justify-end gap-1', className)} data-slot="row-actions" onClick={(e) => e.stopPropagation()}>
      {children}
      {onEdit && <EditButton onClick={onEdit} label={editLabel} title={editTitle} />}
      {onDelete && <DeleteButton onClick={onDelete} label={deleteLabel} title={deleteTitle} />}
    </div>
  );
}

export interface DeleteAsk {
  title: string;
  description: ReactNode;
  /** Offer a reason box (kept in the audit trail and on the deleted record). */
  reason?: boolean;
  confirmLabel?: string;
  /** Does the delete. A thrown error is shown, and the dialog stays open. */
  run: (reason: string | null) => Promise<unknown>;
  /** The toast once done. */
  done?: string;
  doneDescription?: string;
  onDone?: () => void;
  /** What to do instead when the server refuses (Mark as inactive…). */
  instead?: { label: string; run: () => Promise<unknown> | void };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A delete that asks first: `const del = useConfirmDelete()`, then
 * `del.ask({...})` from a Delete button, and `{del.dialog}` once in the page.
 */
export function useConfirmDelete(): { ask: (a: DeleteAsk) => void; dialog: ReactNode } {
  const [ask, setAsk] = useState<DeleteAsk | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  const close = () => { setAsk(null); setReason(''); setRefused(null); };
  const go = async () => {
    if (!ask) return;
    setBusy(true);
    setRefused(null);
    try {
      await ask.run(reason.trim() || null);
      toast.success(ask.done ?? 'Deleted', ask.doneDescription ? { description: ask.doneDescription } : undefined);
      const after = ask.onDone;
      close();
      after?.();
    } catch (e) {
      const text = message(e);
      // Cancelled at the reason prompt: nothing to report.
      if (!/a reason is needed/.test(text)) {
        toast.error('Not deleted', { description: text });
        setRefused(text);
      }
    } finally {
      setBusy(false);
    }
  };
  const instead = async () => {
    if (!ask?.instead) return;
    setBusy(true);
    try {
      await ask.instead.run();
      const after = ask.onDone;
      close();
      after?.();
    } catch (e) {
      toast.error('Not done', { description: message(e) });
    } finally {
      setBusy(false);
    }
  };

  const dialog = (
    <Dialog open={!!ask} onOpenChange={(v) => { if (!v && !busy) close(); }}>
      <DialogContent className="sm:max-w-md" data-slot="confirm-delete">
        <DialogHeader>
          <DialogTitle>{ask?.title}</DialogTitle>
          <DialogDescription>{ask?.description}</DialogDescription>
        </DialogHeader>
        {ask?.reason && (
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional): entered in error"
            maxLength={300} data-slot="confirm-delete-reason" />
        )}
        {refused && (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs leading-relaxed text-destructive" data-slot="confirm-delete-refused">
            {refused}
          </p>
        )}
        <DialogFooter>
          {refused && ask?.instead ? (
            <Button disabled={busy} onClick={() => void instead()} data-slot="confirm-delete-instead">
              {busy && <Loader2 className="size-3.5 animate-spin" />} {ask.instead.label}
            </Button>
          ) : (
            <Button variant="destructive" disabled={busy} onClick={() => void go()} data-slot="confirm-delete-go">
              {busy && <Loader2 className="size-3.5 animate-spin" />} {ask?.confirmLabel ?? 'Delete'}
            </Button>
          )}
          <Button variant="outline" disabled={busy} onClick={close}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { ask: (a) => { setReason(''); setRefused(null); setAsk(a); }, dialog };
}

/** `?reason=…` for a DELETE, or nothing. */
export const reasonQuery = (reason: string | null | undefined, first = true) =>
  reason?.trim() ? `${first ? '?' : '&'}reason=${encodeURIComponent(reason.trim())}` : '';
