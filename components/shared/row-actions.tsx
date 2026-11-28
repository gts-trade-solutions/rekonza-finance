'use client';

// Edit and Delete as buttons a person can see, on a row of a list, a card, or
// at the top of a record dialog. The client looked for "edit and delete"
// (2026-11-25: "wherever we need edit and delete you should give") and did not
// recognise a ⋯ or ▾ menu, nor a bare pencil or bin, as holding them. So
// wherever a record can be changed these two sit on it in words, with their
// icons, as on the General Ledger's rows (components/reports/ledger-entry-actions.tsx).
//
// Delete always asks first, in a dialog, with room for an optional reason
// (sent as ?reason=, kept in the audit trail and with the deleted record where
// the server keeps one). When the server refuses (the account has postings,
// the master is in use, the books forbid it) its message shows in the dialog
// and as a toast, and where there is a gentler way out (Mark as inactive,
// Retire, Set a leaving date) the dialog offers it beside the refusal, as Zoho
// Books does.
//
// Three groups of screens arrived at three shapes of the same dialog; all
// three are kept, each with its own data-slot names, so the screens and their
// tests stay as they were:
//   · RowActions with a `label` asks and deletes by itself (accountant,
//     banking); ConfirmDelete is its dialog on its own;
//   · DeleteConfirmDialog, opened by the screen (purchases, inventory, projects);
//   · useConfirmDelete(), one dialog per page asked with del.ask({...}) (payroll,
//     GST, settings).
// RowActions without a `label` only lays the two buttons out; the screen opens
// whichever dialog it uses.

import { useState, type ReactNode } from 'react';
import { Loader2, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { ApiError, sentForApproval } from '@/lib/api/client';
import { cn } from '@/lib/utils';

const btn = 'inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border bg-background px-2 text-xs font-medium hover:bg-accent disabled:pointer-events-none disabled:opacity-50';

/** The Edit button on its own (a record's header, a card). */
export function EditButton({ onClick, label = 'Edit', title, disabled, slot = 'row-edit', className }: {
  onClick: () => void; label?: string; title?: string; disabled?: boolean; slot?: string; className?: string;
}) {
  return (
    <button type="button" className={cn(btn, 'text-link', className)} data-slot={slot} title={title} disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onClick(); }}>
      <Pencil className="size-3.5" /> {label}
    </button>
  );
}

/** The Delete button on its own; it only opens the question, never deletes by itself. */
export function DeleteButton({ onClick, label = 'Delete', title, disabled, slot = 'row-delete', className }: {
  onClick: () => void; label?: string; title?: string; disabled?: boolean; slot?: string; className?: string;
}) {
  return (
    <button type="button" className={cn(btn, 'text-destructive', className)} data-slot={slot} title={title} disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onClick(); }}>
      <Trash2 className="size-3.5" /> {label}
    </button>
  );
}

/** Edit and Delete that ask and delete by themselves: given the record's `label`. */
export interface ConfirmingRowActionsProps {
  /** The record, in words: "account 6750 Rent". */
  label: string;
  canEdit?: boolean;
  canDelete?: boolean;
  onEdit?: () => void;
  onDelete?: (reason: string) => Promise<unknown>;
  deleteTitle?: string;
  deleteDescription?: ReactNode;
  done?: string;
  alternative?: DeleteAlternative;
  alternativeUpfront?: boolean;
  withReasonField?: boolean;
  /** The reason must be given (a posted document: its entry is reversed, and the reversal says why). */
  reasonRequired?: boolean;
  editLabel?: string;
  deleteLabel?: string;
  editTitle?: string;
  deleteTitleAttr?: string;
  /** More buttons, before Edit. */
  extra?: ReactNode;
  className?: string;
  children?: never;
}

/** Edit and Delete side by side, the screen opening its own dialog. Either is left out when not given. */
export interface PlainRowActionsProps {
  label?: undefined;
  onEdit?: (() => void) | false | null;
  onDelete?: (() => void) | false | null;
  editLabel?: string;
  deleteLabel?: string;
  editTitle?: string;
  deleteTitle?: string;
  /** Other buttons the row has, shown before Edit (Mark verified, Pay…). */
  children?: ReactNode;
  className?: string;
}

/** Edit and Delete on one row: with a `label` it asks and deletes by itself; without one it lays out the buttons. */
export function RowActions(props: ConfirmingRowActionsProps | PlainRowActionsProps) {
  if (props.label !== undefined) return <ConfirmingRowActions {...props} />;
  return <PlainRowActions {...props} />;
}

function PlainRowActions({ onEdit, onDelete, editLabel, deleteLabel, editTitle, deleteTitle, children, className }: PlainRowActionsProps) {
  if (!onEdit && !onDelete && !children) return null;
  return (
    <div className={cn('flex flex-wrap items-center justify-end gap-1', className)} data-slot="row-actions" onClick={(e) => e.stopPropagation()}>
      {children}
      {onEdit && <EditButton onClick={onEdit} label={editLabel} title={editTitle} />}
      {onDelete && <DeleteButton onClick={onDelete} label={deleteLabel} title={deleteTitle} />}
    </div>
  );
}

/** A DELETE path with the reason the person gave, for the routes that keep it (?reason=). */
export function withReason(path: string, reason: string | null | undefined): string {
  const r = reason?.trim();
  if (!r) return path;
  return `${path}${path.includes('?') ? '&' : '?'}reason=${encodeURIComponent(r)}`;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What the delete dialog offers instead when the server refuses (Mark as inactive, Retire). */
export interface DeleteAlternative {
  label: string;
  /** Said under the refusal, before the button. */
  note?: string;
  run: () => Promise<unknown>;
  /** Shown as a toast once it has run. */
  done?: string;
}

export function ConfirmDelete({
  open, onClose, title, description, withReasonField = true, confirmLabel = 'Delete', onConfirm, done, alternative, alternativeUpfront = false, reasonRequired = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: ReactNode;
  /** Ask for an optional reason (most deletes keep one). */
  withReasonField?: boolean;
  confirmLabel?: string;
  /** Throws to refuse; the message is shown. */
  onConfirm: (reason: string) => Promise<unknown>;
  /** Toast once deleted. */
  done?: string;
  alternative?: DeleteAlternative;
  /** Offer the alternative before Delete is tried (when it is known Delete will be refused). */
  alternativeUpfront?: boolean;
  /** The reason must be given, four letters or more (a posted document). */
  reasonRequired?: boolean;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const close = () => { setReason(''); setRefused(null); onClose(); };

  const go = async () => {
    setBusy(true);
    setRefused(null);
    try {
      await onConfirm(reason.trim());
      if (done) toast.success(done);
      setReason('');
      onClose();
    } catch (e) {
      if (sentForApproval(e)) { setReason(''); onClose(); return; }
      const msg = errText(e);
      setRefused(msg);
      toast.error('Not deleted', { description: msg });
    } finally {
      setBusy(false);
    }
  };
  const instead = async () => {
    if (!alternative) return;
    setBusy(true);
    try {
      await alternative.run();
      toast.success(alternative.done ?? 'Done');
      setReason(''); setRefused(null);
      onClose();
    } catch (e) {
      toast.error('That did not go through', { description: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  const offer = alternative && (refused || alternativeUpfront);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) close(); }}>
      <DialogContent className="sm:max-w-md" data-slot="confirm-delete">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {(withReasonField || reasonRequired) && !refused && (
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={reasonRequired ? 'Reason (needed): entered in error' : 'Reason (optional): entered in error'}
            maxLength={300} data-slot="delete-reason" />
        )}
        {refused && (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" data-slot="delete-refused">{refused}</p>
        )}
        {offer && alternative?.note && <p className="text-xs text-muted-foreground">{alternative.note}</p>}
        <DialogFooter className="gap-2">
          {offer && (
            <Button variant="outline" disabled={busy} onClick={() => void instead()} data-slot="delete-alternative">{alternative!.label}</Button>
          )}
          {!refused && (
            <Button variant="destructive" disabled={busy || (reasonRequired && reason.trim().length < 4)} onClick={() => void go()} data-slot="confirm-delete-go">
              {busy && <Loader2 className="size-3.5 animate-spin" />} {confirmLabel}
            </Button>
          )}
          <Button variant="outline" onClick={close}>{refused ? 'Close' : 'Cancel'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Edit and Delete on one row. Edit runs `onEdit` (usually opens a dialog);
 * Delete asks, then runs `onDelete` with the reason given.
 */
function ConfirmingRowActions({
  label, canEdit = true, canDelete = true, onEdit, onDelete, deleteTitle, deleteDescription, done, alternative, alternativeUpfront,
  withReasonField, reasonRequired, editLabel, deleteLabel, editTitle, deleteTitleAttr, extra, className,
}: ConfirmingRowActionsProps) {
  const [asking, setAsking] = useState(false);
  const showEdit = canEdit && !!onEdit;
  const showDelete = canDelete && !!onDelete;
  if (!showEdit && !showDelete && !extra) return null;
  // The dialog sits inside the same element: React carries a click inside it (in its portal) up
  // through this element, so it must stop here too, or a clickable table row would open behind it.
  return (
    <div className={cn('flex items-center justify-end gap-1', className)} data-slot="row-actions" aria-label={`Actions for ${label}`}
      onClick={(e) => e.stopPropagation()}>
      {extra}
      {showEdit && <EditButton onClick={onEdit!} label={editLabel} title={editTitle ?? `Edit ${label}`} />}
      {showDelete && <DeleteButton onClick={() => setAsking(true)} label={deleteLabel} title={deleteTitleAttr ?? `Delete ${label}`} />}
      {showDelete && (
        <ConfirmDelete
          open={asking}
          onClose={() => setAsking(false)}
          title={deleteTitle ?? `Delete ${label}?`}
          description={deleteDescription ?? 'It is removed, and the audit trail keeps a record of who deleted it and when.'}
          onConfirm={onDelete!}
          done={done}
          alternative={alternative}
          alternativeUpfront={alternativeUpfront}
          withReasonField={withReasonField}
          reasonRequired={reasonRequired}
        />
      )}
    </div>
  );
}

export interface DeleteConfirmProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "Delete purchase order PO-0012?" */
  title: string;
  /** What happens: what is reversed, what is kept. */
  description: ReactNode;
  /** Delete it; throws the server's refusal. Gets the reason typed, if any. */
  onConfirm: (reason: string | undefined) => Promise<unknown>;
  /** Told after it is gone. */
  onDone?: () => void;
  /** "PO-0012 deleted". */
  doneMessage?: string;
  /** A reason box (kept with the record). Off for things that are not documents. */
  withReason?: boolean;
  /** The reason must be given, four letters or more: a posted document, whose reversal says why. */
  reasonRequired?: boolean;
  confirmLabel?: string;
  /**
   * What to offer when the server refuses with `in_use`: Zoho's "Mark as
   * inactive" for a master other records rest on.
   */
  inUse?: { label: string; run: () => Promise<unknown>; doneMessage?: string };
}

/** Delete, asked once: what happens, an optional reason, the refusal if there is one. */
export function DeleteConfirmDialog({
  open, onOpenChange, title, description, onConfirm, onDone, doneMessage, withReason = true, reasonRequired = false, confirmLabel = 'Delete', inUse,
}: DeleteConfirmProps) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; code: string } | null>(null);
  const close = () => { onOpenChange(false); setReason(''); setError(null); };

  const run = async () => {
    setBusy(true); setError(null);
    try {
      await onConfirm(withReason || reasonRequired ? reason.trim() || undefined : undefined);
      if (doneMessage) toast.success(doneMessage);
      close();
      onDone?.();
    } catch (e) {
      if (sentForApproval(e)) { close(); return; }
      const message = e instanceof Error ? e.message : String(e);
      const code = e instanceof ApiError ? e.code : 'error';
      setError({ message, code });
      toast.error('Not deleted', { description: message });
    } finally {
      setBusy(false);
    }
  };
  const fallBack = async () => {
    if (!inUse) return;
    setBusy(true);
    try {
      await inUse.run();
      toast.success(inUse.doneMessage ?? 'Marked as inactive');
      close();
      onDone?.();
    } catch (e) {
      toast.error('Not changed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) close(); }}>
      <DialogContent className="sm:max-w-md" onClick={(e) => e.stopPropagation()} data-slot="delete-confirm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {(withReason || reasonRequired) && (
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300}
            placeholder={reasonRequired ? 'Reason (needed): entered in error' : 'Reason (optional): entered in error'} data-slot="delete-confirm-reason" />
        )}
        {error && <p className="text-sm text-destructive" data-slot="delete-confirm-error">{error.message}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>Cancel</Button>
          {inUse && error?.code === 'in_use' && (
            <Button variant="secondary" onClick={() => void fallBack()} disabled={busy} data-slot="delete-confirm-inactive">{inUse.label}</Button>
          )}
          <Button variant="destructive" onClick={() => void run()} disabled={busy || (reasonRequired && reason.trim().length < 4)} className="gap-1.5" data-slot="delete-confirm-go">
            {busy && <Loader2 className="size-3.5 animate-spin" />} {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** `?reason=` for a DELETE, as the document routes read it. */
export const withReasonQuery = (path: string, reason?: string | null) =>
  reason?.trim() ? `${path}${path.includes('?') ? '&' : '?'}reason=${encodeURIComponent(reason.trim())}` : path;

export interface DeleteAsk {
  title: string;
  description: ReactNode;
  /**
   * The reason box (kept in the audit trail and on the deleted record). Shown
   * unless set false: every DELETE falls under a book's rule that each change
   * gives a reason, and one typed here answers it.
   */
  reason?: boolean;
  /** The reason must be given (four letters or more): reopening a posted payroll. */
  reasonRequired?: boolean;
  confirmLabel?: string;
  /** For a confirm that is not a delete (Reopen, Undo payment): a plain button, and its own failure title. */
  tone?: 'destructive' | 'default';
  failTitle?: string;
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
      if (sentForApproval(e)) { close(); return; }
      const text = message(e);
      // Cancelled at the reason prompt: nothing to report.
      if (!/a reason is needed/.test(text)) {
        toast.error(ask.failTitle ?? 'Not deleted', { description: text });
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
        {ask && (ask.reason !== false || ask.reasonRequired) && (
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} data-slot="confirm-delete-reason"
            placeholder={ask.reasonRequired ? 'Reason (needed): leave days were wrong' : 'Reason (optional): entered in error'} />
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
            <Button variant={ask?.tone === 'default' ? 'default' : 'destructive'} disabled={busy || (!!ask?.reasonRequired && reason.trim().length < 4)}
              onClick={() => void go()} data-slot="confirm-delete-go">
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
