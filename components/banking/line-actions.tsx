'use client';

// Edit and Delete on one bank statement line, as buttons (the client looks for
// them in words, 2026-11-25), wherever lines are listed: an account's
// Uncategorized and Excluded tabs, Quick Categorize (statement lines), and the
// reconcile screen.
//
// A line is the bank's own record, so what the buttons do depends on where it
// stands (services/banking-changes.ts):
// - uncategorised or excluded: Edit corrects what the statement says (a date
//   or narration mis-read at import, an amount on the wrong side); Delete
//   removes a line imported by mistake. Its import fingerprint stays, so the
//   same statement imported again does not bring it back twice.
// - categorised or matched: Edit undoes the categorisation and reopens the line
//   to categorise it again; Delete undoes the categorisation only (what it
//   recorded is reversed or voided) and the line stays, uncategorised.

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { RowActions, withReason } from '@/components/shared/row-actions';
import { api } from '@/lib/api/client';
import { usePermission } from '@/lib/store/hooks';

export interface StatementLineRef {
  id: string; date: string; narration: string; reference: string | null;
  depositPaise: number; withdrawalPaise: number; status: string;
}

export function StatementLineActions({ line, onChanged, onReopen, className }: {
  line: StatementLineRef;
  onChanged: () => void;
  /** After Edit on a categorised line: open it to categorise again. */
  onReopen?: (lineId: string) => void;
  className?: string;
}) {
  const canEdit = usePermission('banking', 'edit');
  const canDelete = usePermission('banking', 'void');
  const [editing, setEditing] = useState(false);
  const categorised = line.status === 'matched' || line.status === 'manually_added';
  const label = `the line of ${line.date.slice(0, 10)}`;

  const undo = () => api.post('/api/banking/transactions', { action: 'unmatch', transactionId: line.id });
  const recategorise = async () => {
    try {
      await undo();
      toast.success('Categorisation undone', { description: 'Choose its category again.' });
      onChanged();
      onReopen?.(line.id);
    } catch (e) {
      toast.error('Not reopened', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <>
      <RowActions
        className={className}
        label={label}
        canEdit={canEdit}
        canDelete={canDelete || (categorised && canEdit)}
        editTitle={categorised ? 'Undo the categorisation and choose it again' : 'Correct the date, narration, reference or amount'}
        deleteTitleAttr={categorised ? 'Undo the categorisation; the line stays, uncategorised' : 'Delete this line (imported by mistake)'}
        onEdit={() => (categorised ? void recategorise() : setEditing(true))}
        onDelete={async (reason) => {
          if (categorised) await undo();
          else await api.delete(withReason(`/api/banking/transactions/${line.id}`, reason));
          onChanged();
        }}
        done={categorised ? 'Categorisation deleted: the line is uncategorised again' : 'Statement line deleted'}
        deleteTitle={categorised ? `Delete the categorisation of ${label}?` : `Delete ${label}?`}
        deleteDescription={categorised
          ? 'What it recorded (the receipt, payment, expense, transfer or entry) is voided or reversed, and the line goes back to Uncategorized. The line itself comes from the bank statement and stays.'
          : 'The line leaves the account. Its import fingerprint is kept, so importing the same statement again does not bring it back twice.'}
        withReasonField={!categorised}
      />
      {editing && <EditLineDialog line={line} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); onChanged(); }} />}
    </>
  );
}

/** Correct an uncategorised line: what the statement should have said. */
export function EditLineDialog({ line, onClose, onSaved }: { line: StatementLineRef; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    date: line.date.slice(0, 10), narration: line.narration, reference: line.reference ?? '',
    side: line.depositPaise > 0 ? 'in' as const : 'out' as const, amount: line.depositPaise || line.withdrawalPaise,
  });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/api/banking/transactions/${line.id}`, {
        date: f.date, narration: f.narration, reference: f.reference.trim() || null,
        depositPaise: f.side === 'in' ? f.amount : 0, withdrawalPaise: f.side === 'out' ? f.amount : 0,
      });
      toast.success('Statement line saved');
      onSaved();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-lg" data-slot="statement-line-edit">
        <DialogHeader>
          <DialogTitle>Edit statement line</DialogTitle>
          <DialogDescription>Correct what the bank statement says, while the line is still uncategorised.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Date" required><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <Field label="Reference"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} maxLength={100} /></Field>
          <Field label="Narration" required className="sm:col-span-2"><Input value={f.narration} onChange={(e) => setF({ ...f, narration: e.target.value })} maxLength={500} /></Field>
          <Field label="Money">
            <div className="flex w-fit rounded-md border p-0.5 text-xs">
              {(['in', 'out'] as const).map((k) => (
                <button key={k} type="button" onClick={() => setF({ ...f, side: k })}
                  className={`rounded px-2.5 py-1 ${f.side === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>
                  {k === 'in' ? 'Deposit (in)' : 'Withdrawal (out)'}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Amount" required><MoneyInput valuePaise={f.amount} onChangePaise={(p) => setF({ ...f, amount: p })} /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !f.narration.trim() || f.amount <= 0 || !f.date} data-slot="statement-line-save">{busy ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
