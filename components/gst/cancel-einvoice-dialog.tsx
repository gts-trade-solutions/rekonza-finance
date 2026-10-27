'use client';

// Cancelling an IRN, from wherever an invoice is shown.
//
// Two facts decide how this reads, and both are said before the button rather
// than after it: it is possible only for 24 hours after the IRN was issued,
// and it voids the invoice in the books, because the portal will never accept
// that invoice number again.

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/shared/form-bits';
import { gst } from '@/lib/api/client';
import { useApiAction } from '@/lib/api/use-api';
import { timeLeft } from '@/lib/tax/einvoice';
import { cn } from '@/lib/utils';

type ReasonCode = '1' | '2' | '3' | '4';

// The portal's own codes, most common first. It accepts nothing else.
const REASONS: { code: ReasonCode; label: string }[] = [
  { code: '2', label: 'Data entry mistake' },
  { code: '1', label: 'Duplicate' },
  { code: '3', label: 'Order cancelled' },
  { code: '4', label: 'Other' },
];

export function CancelEinvoiceDialog({
  open,
  onOpenChange,
  invoiceId,
  number,
  cancelUntil,
  onCancelled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoiceId: string;
  number: string;
  /** When the 24-hour window closes, as ISO. */
  cancelUntil: string | null;
  onCancelled: () => void;
}) {
  const [reason, setReason] = useState<ReasonCode>('2');
  const [remark, setRemark] = useState('');
  const cancel = useApiAction(gst.cancelEinvoice);

  const submit = async () => {
    const done = await cancel.run(invoiceId, reason, remark.trim());
    if (!done) return; // the reason is shown in the dialog
    toast.success(`IRN cancelled for ${number}`, {
      description: [
        'The invoice is void and its journal entry reversed.',
        done.live ? null : 'Nothing was filed: the IRN came from the stand-in or a sandbox.',
        done.recovered ? 'The portal had already cancelled it; the books now agree.' : null,
      ]
        .filter(Boolean)
        .join(' '),
    });
    setRemark('');
    onOpenChange(false);
    onCancelled();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="cancel-einvoice">
        <DialogHeader>
          <DialogTitle>Cancel the IRN for {number}?</DialogTitle>
          <DialogDescription>
            This also voids {number} in your books: its journal entry is reversed, and the portal will not accept
            this invoice number again. If the sale stands, raise a fresh invoice afterwards.
            {cancelUntil && <> The window closes in {timeLeft(cancelUntil)}.</>}
          </DialogDescription>
        </DialogHeader>

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Reason</legend>
          <div className="grid grid-cols-2 gap-2">
            {REASONS.map((r) => (
              <label
                key={r.code}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-[3px] border px-3 py-2 text-sm transition-colors',
                  reason === r.code ? 'border-primary bg-primary/5' : 'hover:bg-accent/40',
                )}
              >
                <input
                  type="radio"
                  name="cancel-reason"
                  value={r.code}
                  checked={reason === r.code}
                  onChange={() => setReason(r.code)}
                  className="accent-primary"
                />
                {r.label}
              </label>
            ))}
          </div>
        </fieldset>

        <Field label="Remark" hint="Sent to the portal, up to 100 characters">
          <Input
            value={remark}
            maxLength={100}
            onChange={(e) => setRemark(e.target.value)}
            placeholder="Wrong rate on one line"
            data-slot="cancel-remark"
          />
        </Field>

        {cancel.error && <p className="text-sm text-destructive">{cancel.error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep the IRN
          </Button>
          <Button
            variant="destructive"
            disabled={cancel.busy}
            onClick={() => void submit()}
            className="gap-1.5"
            data-slot="confirm-cancel-einvoice"
          >
            {cancel.busy && <Loader2 className="size-3.5 animate-spin" />} Cancel IRN and void invoice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
