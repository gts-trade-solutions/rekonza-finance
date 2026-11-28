'use client';

// View / Edit / Delete on one row of the General Ledger (the client asked for
// them there, 2026-11-25). They are buttons on the row, not a ⋯ menu: the
// client looked for "edit and delete" and did not find them behind the dots. A ledger row is one line of a journal
// entry; what can be changed is the document behind it, so each kind goes to
// that document's own edit and delete — the same rules apply (a reason when the
// book asks for one, refused once money is applied or the period is locked),
// and the ledger keeps the old entry with its reversal, never erased.
//
// - A reversal, or an entry already reversed, is shown as such and not offered
//   again: undoing it twice would be wrong.
// - A bank line categorised from Banking: Delete undoes the categorisation (its
//   entry is reversed; the bank's own line stays, uncategorised); Edit undoes
//   it and reopens the line to categorise it again.
// - Entries posted by their own screens (payroll, depreciation, statutory
//   payments, opening balances, stock) open that screen, where they are changed.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Eye, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { api } from '@/lib/api/client';
import { usePermission } from '@/lib/store/hooks';
import { sourceHref } from '@/lib/source-links';
import { withReason } from '@/components/shared/row-actions';

export interface LedgerRowRef {
  entryId: string;
  entryNo: number;
  sourceType: string;
  sourceId: string | null;
  reversalOf?: { entryId: string; entryNo: number } | null;
  reversedBy?: { entryId: string; entryNo: number } | null;
}

/** A journal list's entry (api/journal) as a ledger row: what its View, Edit and Delete need. */
export function journalRowRef(e: {
  id: string; entryNo: number; sourceType: string; sourceId: string | null;
  reversalOfRef?: { entryId: string; entryNo: number } | null; reversedByRef?: { entryId: string; entryNo: number } | null;
  reversalOf?: string | null; reversedBy?: number | null;
}): LedgerRowRef {
  return {
    entryId: e.id, entryNo: e.entryNo, sourceType: e.sourceType, sourceId: e.sourceId,
    reversalOf: e.reversalOfRef ?? (e.reversalOf ? { entryId: e.reversalOf, entryNo: 0 } : null),
    reversedBy: e.reversedByRef ?? (e.reversedBy ? { entryId: '', entryNo: e.reversedBy } : null),
  };
}

type Module = 'sales' | 'purchases' | 'accountant' | 'banking';
interface Kind {
  noun: string;
  module: Module;
  /** Where Edit opens, from the document's id (or the entry's, for a journal). */
  edit?: (id: string) => string;
  /** The DELETE route (a reason is added). */
  del?: (id: string) => string;
  /** A journal is addressed by its entry; everything else by its document. */
  byEntry?: boolean;
}

/** Each kind of document a ledger row can come from, and how it is changed. */
export const LEDGER_KINDS: Record<string, Kind> = {
  invoice: { noun: 'invoice', module: 'sales', edit: (id) => `/sales/invoices/${id}/edit`, del: (id) => `/api/invoices/${id}` },
  payment_received: { noun: 'payment', module: 'sales', edit: (id) => `/sales/payments/new?edit=${id}`, del: (id) => `/api/payments/${id}` },
  payment_made: { noun: 'payment', module: 'purchases', edit: (id) => `/purchases/payments/new?edit=${id}`, del: (id) => `/api/payments/${id}` },
  expense: { noun: 'expense', module: 'purchases', edit: (id) => `/purchases/expenses?edit=${id}`, del: (id) => `/api/expenses/${id}` },
  credit_note: { noun: 'credit note', module: 'sales', edit: (id) => `/sales/credit-notes/${id}/edit`, del: (id) => `/api/sales-documents/credit-note/${id}` },
  retainer: { noun: 'service invoice', module: 'sales', edit: (id) => `/sales/retainers/${id}/edit`, del: (id) => `/api/retainers/${id}` },
  manual: { noun: 'journal', module: 'accountant', byEntry: true, edit: (id) => `/accountant/journals?edit=${id}`, del: (id) => `/api/journal/${id}` },
  bill: { noun: 'bill', module: 'purchases', edit: (id) => `/purchases/bills/${id}/edit`, del: (id) => `/api/bills/${id}` },
  vendor_credit: { noun: 'vendor credit', module: 'purchases', edit: (id) => `/purchases/vendor-credits?edit=${id}`, del: (id) => `/api/vendor-credits/${id}` },
  // A receipt note's own entry; the "accrual taken back" entry a bill posts under the same kind is
  // refused by the server ("Delete the bill first"), with its reason shown.
  goods_receipt: { noun: 'goods receipt', module: 'purchases', edit: (id) => `/purchases/goods-receipts?edit=${id}`, del: (id) => `/api/goods-receipts/${id}` },
  bank_txn: { noun: 'bank line categorisation', module: 'banking' },
  // Banking and the accountant's own entries (2026-11-25): a transfer between two accounts is edited
  // and deleted as a transfer (reversed and reposted); a cash count's short or excess goes with its
  // count; money typed in on a bank account (Add Transaction), a recurring journal's entry, an
  // imported journal and a reclassification are journals, changed as one is.
  transfer: { noun: 'transfer', module: 'banking', edit: (id) => `/banking/transfers?edit=${id}`, del: (id) => `/api/banking/transfers/${id}` },
  cash_count: { noun: 'cash count', module: 'banking', edit: (id) => `/reports/cash-book?count=${id}`, del: (id) => `/api/cash-book?id=${id}` },
  bank_entry: { noun: 'bank transaction', module: 'accountant', byEntry: true, edit: (id) => `/accountant/journals?edit=${id}`, del: (id) => `/api/journal/${id}` },
  recurring: { noun: 'journal', module: 'accountant', byEntry: true, edit: (id) => `/accountant/journals?edit=${id}`, del: (id) => `/api/journal/${id}` },
  tally_import: { noun: 'journal', module: 'accountant', byEntry: true, edit: (id) => `/accountant/journals?edit=${id}`, del: (id) => `/api/journal/${id}` },
  reclassification: { noun: 'journal', module: 'accountant', byEntry: true, edit: (id) => `/accountant/journals?edit=${id}`, del: (id) => `/api/journal/${id}` },
};

export function LedgerEntryActions({ row, onChanged }: { row: LedgerRowRef; onChanged: () => void }) {
  const router = useRouter();
  const kind = LEDGER_KINDS[row.sourceType];
  const canEdit = usePermission(kind?.module ?? 'accountant', 'edit');
  const canDelete = usePermission(kind?.module ?? 'accountant', 'void');
  const [confirm, setConfirm] = useState<null | 'delete' | 'edit'>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const view = row.sourceType === 'manual' ? `/accountant/journals` : sourceHref(row.sourceType, row.sourceId);
  const id = kind?.byEntry ? row.entryId : row.sourceId;

  // A reversal, or an entry already undone, is read, not changed.
  if (row.reversalOf || row.reversedBy) {
    return (
      <span className="whitespace-nowrap text-[11px] text-muted-foreground" data-slot="ledger-reversed">
        {row.reversalOf ? `Reversal of #${row.reversalOf.entryNo}` : `Reversed by #${row.reversedBy!.entryNo}`}
      </span>
    );
  }

  const bank = row.sourceType === 'bank_txn';
  const editable = !!kind && !!id && (bank || !!kind.edit) && canEdit;
  const deletable = !!kind && !!id && (bank || !!kind.del) && canDelete;
  if (!view && !bank && !editable && !deletable) return null;

  // A bank line is shown on its account's reconcile page, opened at the line.
  const bankAccountOf = async (lineId: string) =>
    (await api.get<{ line: { bankAccountId: string } }>(`/api/banking/transactions/${lineId}`)).line.bankAccountId;
  const viewBankLine = async () => {
    try { router.push(`/banking/reconcile?account=${await bankAccountOf(row.sourceId!)}&line=${row.sourceId}`); }
    catch (e) { toast.error('That bank line could not be opened', { description: e instanceof Error ? e.message : String(e) }); }
  };
  const undoBankLine = async () => {
    await api.post('/api/banking/transactions', { action: 'unmatch', transactionId: row.sourceId });
  };
  const run = async () => {
    setBusy(true);
    try {
      if (bank && confirm === 'edit') {
        const account = await bankAccountOf(row.sourceId!);
        await undoBankLine();
        toast.success('Categorisation undone', { description: 'Choose its category again.' });
        router.push(`/banking/reconcile?account=${account}&line=${row.sourceId}`);
        return;
      }
      if (bank) {
        await undoBankLine();
        toast.success(`Entry #${row.entryNo} deleted`, { description: 'The bank line is uncategorised again; its entry is reversed in the ledger.' });
      } else {
        const r = reason.trim();
        await api.delete(withReason(kind!.del!(id!), r));
        toast.success(`The ${kind!.noun} behind entry #${row.entryNo} is deleted`, { description: 'Its entry is reversed in the ledger; the audit trail keeps it.' });
      }
      setConfirm(null); setReason('');
      onChanged();
    } catch (e) {
      toast.error(confirm === 'edit' ? 'Not reopened' : 'Not deleted', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const btn = 'inline-flex h-7 items-center gap-1 rounded-md border bg-background px-2 text-xs font-medium hover:bg-accent';
  return (
    <>
      <div className="flex items-center justify-end gap-1" data-slot="ledger-actions" aria-label={`Actions for entry #${row.entryNo}`}>
        {bank && row.sourceId ? (
          <button type="button" onClick={() => void viewBankLine()} className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent" aria-label={`View entry #${row.entryNo}`} title="View" data-slot="ledger-view">
            <Eye className="size-4" />
          </button>
        ) : view && (
          <Link href={view} className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent" aria-label={`View entry #${row.entryNo}`} title="View" data-slot="ledger-view">
            <Eye className="size-4" />
          </Link>
        )}
        {editable && (
          <button type="button" className={`${btn} text-link`} data-slot="ledger-edit" title={bank ? 'Undo the categorisation and choose it again' : `Edit the ${kind!.noun}`}
            onClick={() => (bank ? setConfirm('edit') : router.push(kind!.edit!(id!)))}>
            <Pencil className="size-3.5" /> Edit
          </button>
        )}
        {deletable && (
          <button type="button" className={`${btn} text-destructive`} data-slot="ledger-delete" title={bank ? 'Undo the categorisation; the bank line stays, uncategorised' : `Delete the ${kind!.noun}`}
            onClick={() => setConfirm('delete')}>
            <Trash2 className="size-3.5" /> Delete
          </button>
        )}
      </div>
      <Dialog open={!!confirm} onOpenChange={(v) => { if (!v) { setConfirm(null); setReason(''); } }}>
        <DialogContent className="sm:max-w-md" data-slot="ledger-confirm">
          <DialogHeader>
            <DialogTitle>
              {bank ? (confirm === 'edit' ? `Re-categorise entry #${row.entryNo}?` : `Delete entry #${row.entryNo}?`) : `Delete the ${kind?.noun} behind entry #${row.entryNo}?`}
            </DialogTitle>
            <DialogDescription>
              {bank
                ? 'This entry is reversed in the ledger and the bank line goes back to uncategorised; the line itself comes from the bank statement and stays (the audit trail keeps both).' + (confirm === 'edit' ? ' It then opens for you to categorise it again.' : '')
                : 'Its entry is reversed in the ledger and the document is removed; its number is kept as deleted. Refused if money has been applied to it or its period is locked.'}
            </DialogDescription>
          </DialogHeader>
          {/* The entry is reversed: the reversal says why (Accountant → Reversed Vouchers). */}
          {!bank && <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Reason (needed): raised in error" data-slot="ledger-reason" />}
          <DialogFooter>
            <Button variant={confirm === 'delete' ? 'destructive' : 'default'} disabled={busy || (!bank && reason.trim().length < 4)} onClick={() => void run()} data-slot="ledger-confirm-go">
              {busy ? 'Working…' : bank && confirm === 'edit' ? 'Undo and re-categorise' : 'Delete'}
            </Button>
            <Button variant="outline" onClick={() => { setConfirm(null); setReason(''); }}>Cancel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
