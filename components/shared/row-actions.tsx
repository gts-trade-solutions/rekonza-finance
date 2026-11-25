'use client';

// Edit and Delete as buttons a person can see, on a row or a card, with Delete
// asked once in a dialog first (2026-11-25: "wherever we need edit and delete
// you should give"). The client did not recognise a ⋯ menu, nor a bare pencil
// or bin, as edit and delete: each button carries its word beside its icon, as
// the General Ledger's do (components/reports/ledger-entry-actions.tsx).
//
// The dialog keeps an optional reason (sent as ?reason=, kept with the record
// and in the audit trail) and shows the server's refusal as a toast and in the
// dialog. A master that is in use is refused by the server with the code
// `in_use`; where the screen can offer what Zoho offers instead — "Mark as
// inactive" — the dialog shows that button beside the refusal.

import { useState } from 'react';
import { Loader2, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { ApiError } from '@/lib/api/client';
import { cn } from '@/lib/utils';

const btn = 'inline-flex h-7 items-center gap-1 rounded-md border bg-background px-2 text-xs font-medium hover:bg-accent disabled:pointer-events-none disabled:opacity-50';

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

/**
 * Edit and Delete side by side. Either is left out when its handler is not
 * given (no right to it, or the row's state does not allow it).
 */
export function RowActions({ onEdit, onDelete, editTitle, deleteTitle, deleteLabel, children, className }: {
  onEdit?: (() => void) | null;
  onDelete?: (() => void) | null;
  editTitle?: string;
  deleteTitle?: string;
  deleteLabel?: string;
  /** Other buttons the row has, shown before Edit. */
  children?: React.ReactNode;
  className?: string;
}) {
  if (!onEdit && !onDelete && !children) return null;
  return (
    <div className={cn('flex flex-wrap items-center justify-end gap-1', className)} data-slot="row-actions">
      {children}
      {onEdit && <EditButton onClick={onEdit} title={editTitle} />}
      {onDelete && <DeleteButton onClick={onDelete} title={deleteTitle} label={deleteLabel} />}
    </div>
  );
}

export interface DeleteConfirmProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "Delete purchase order PO-0012?" */
  title: string;
  /** What happens: what is reversed, what is kept. */
  description: React.ReactNode;
  /** Delete it; throws the server's refusal. Gets the reason typed, if any. */
  onConfirm: (reason: string | undefined) => Promise<unknown>;
  /** Told after it is gone. */
  onDone?: () => void;
  /** "PO-0012 deleted". */
  doneMessage?: string;
  /** A reason box (kept with the record). Off for things that are not documents. */
  withReason?: boolean;
  confirmLabel?: string;
  /**
   * What to offer when the server refuses with `in_use`: Zoho's "Mark as
   * inactive" for a master other records rest on.
   */
  inUse?: { label: string; run: () => Promise<unknown>; doneMessage?: string };
}

/** Delete, asked once: what happens, an optional reason, the refusal if there is one. */
export function DeleteConfirmDialog({
  open, onOpenChange, title, description, onConfirm, onDone, doneMessage, withReason = true, confirmLabel = 'Delete', inUse,
}: DeleteConfirmProps) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; code: string } | null>(null);
  const close = () => { onOpenChange(false); setReason(''); setError(null); };

  const run = async () => {
    setBusy(true); setError(null);
    try {
      await onConfirm(withReason ? reason.trim() || undefined : undefined);
      if (doneMessage) toast.success(doneMessage);
      close();
      onDone?.();
    } catch (e) {
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
        {withReason && (
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300}
            placeholder="Reason (optional): entered in error" data-slot="delete-confirm-reason" />
        )}
        {error && <p className="text-sm text-destructive" data-slot="delete-confirm-error">{error.message}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>Cancel</Button>
          {inUse && error?.code === 'in_use' && (
            <Button variant="secondary" onClick={() => void fallBack()} disabled={busy} data-slot="delete-confirm-inactive">{inUse.label}</Button>
          )}
          <Button variant="destructive" onClick={() => void run()} disabled={busy} className="gap-1.5" data-slot="delete-confirm-go">
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
