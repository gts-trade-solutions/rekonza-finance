'use client';

// Edit and Delete as buttons a person can see, on a row of a list or at the
// top of a record dialog. The client looked for "edit and delete" and did not
// recognise a ⋯ or ▾ menu as holding them (2026-11-25), so wherever a record
// can be changed these two sit on it in words, with their icons, as on the
// General Ledger's rows (components/reports/ledger-entry-actions.tsx).
//
// Delete always asks first, in a dialog, with room for an optional reason (it
// goes into the audit trail, and into the deleted-documents record where the
// server keeps one). When the server refuses — the account has postings, the
// cost centre is on invoices — its message is shown in the dialog and as a
// toast, and where there is a gentler way out (Mark as inactive, Retire) the
// dialog offers it beside the refusal, as Zoho Books does.

import { useState, type ReactNode } from 'react';
import { Loader2, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

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
  open, onClose, title, description, withReasonField = true, confirmLabel = 'Delete', onConfirm, done, alternative, alternativeUpfront = false,
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
        {withReasonField && !refused && (
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional): entered in error"
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
            <Button variant="destructive" disabled={busy} onClick={() => void go()} data-slot="confirm-delete-go">
              {busy && <Loader2 className="size-3.5 animate-spin" />} {confirmLabel}
            </Button>
          )}
          <Button variant="outline" onClick={close}>{refused ? 'Close' : 'Cancel'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const btn = 'inline-flex h-7 items-center gap-1 rounded-md border bg-background px-2 text-xs font-medium hover:bg-accent disabled:pointer-events-none disabled:opacity-50';

/** The Edit button on its own (a record dialog's header, a card). */
export function EditButton({ onClick, label = 'Edit', title, disabled, className }: { onClick: () => void; label?: string; title?: string; disabled?: boolean; className?: string }) {
  return (
    <button type="button" className={cn(btn, 'text-link', className)} onClick={onClick} title={title} disabled={disabled} data-slot="row-edit">
      <Pencil className="size-3.5" /> {label}
    </button>
  );
}

/** The Delete button on its own: opens the confirm dialog it is given. */
export function DeleteButton({ onClick, label = 'Delete', title, disabled, className }: { onClick: () => void; label?: string; title?: string; disabled?: boolean; className?: string }) {
  return (
    <button type="button" className={cn(btn, 'text-destructive', className)} onClick={onClick} title={title} disabled={disabled} data-slot="row-delete">
      <Trash2 className="size-3.5" /> {label}
    </button>
  );
}

/**
 * Edit and Delete on one row. Edit runs `onEdit` (usually opens a dialog);
 * Delete asks, then runs `onDelete` with the reason given.
 */
export function RowActions({
  label, canEdit = true, canDelete = true, onEdit, onDelete, deleteTitle, deleteDescription, done, alternative, alternativeUpfront,
  withReasonField, editLabel, deleteLabel, editTitle, deleteTitleAttr, extra, className,
}: {
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
  editLabel?: string;
  deleteLabel?: string;
  editTitle?: string;
  deleteTitleAttr?: string;
  /** More buttons, before Edit. */
  extra?: ReactNode;
  className?: string;
}) {
  const [asking, setAsking] = useState(false);
  const showEdit = canEdit && !!onEdit;
  const showDelete = canDelete && !!onDelete;
  if (!showEdit && !showDelete && !extra) return null;
  return (
    <>
      <div className={cn('flex items-center justify-end gap-1', className)} data-slot="row-actions" aria-label={`Actions for ${label}`}
        onClick={(e) => e.stopPropagation()}>
        {extra}
        {showEdit && <EditButton onClick={onEdit!} label={editLabel} title={editTitle ?? `Edit ${label}`} />}
        {showDelete && <DeleteButton onClick={() => setAsking(true)} label={deleteLabel} title={deleteTitleAttr ?? `Delete ${label}`} />}
      </div>
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
        />
      )}
    </>
  );
}
