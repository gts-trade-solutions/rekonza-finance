'use client';

// ─────────────────────────────────────────────────────────────────────────────
// The "e" mark Zoho puts on invoices that have been through the Invoice
// Registration Portal. It is not decoration: an e-invoice without an IRN is not
// a legally valid document, and the customer can be denied their input credit.
// So the mark carries state — registered, pending, failed or cancelled — and
// says which, rather than just appearing when things went well.
// ─────────────────────────────────────────────────────────────────────────────

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { EInvoiceInfo } from '@/lib/types';

const STATE: Record<
  EInvoiceInfo['status'],
  { tone: string; label: string; detail: string } | null
> = {
  not_applicable: null,
  submitted: {
    tone: 'border-success/40 bg-success/10 text-success',
    label: 'e-Invoice registered',
    detail: 'The IRP has issued an IRN and signed QR code. This invoice is legally valid.',
  },
  pending: {
    tone: 'border-warning/50 bg-warning/10 text-warning',
    label: 'e-Invoice pending',
    detail: 'Not yet reported to the IRP. B2B invoices are not valid without an IRN, and there is a 30-day window.',
  },
  failed: {
    tone: 'border-destructive/40 bg-destructive/10 text-destructive',
    label: 'e-Invoice rejected',
    detail: 'The IRP rejected this invoice. Open it to see the error and retry.',
  },
  cancelled: {
    tone: 'border-muted-foreground/30 bg-muted text-muted-foreground',
    label: 'e-Invoice cancelled',
    detail: 'The IRN was cancelled within the 24-hour window.',
  },
};

/**
 * @param compact list rows — just the mark
 * @param withLabel detail screens — mark plus wording
 */
export function EInvoiceMark({
  einvoice,
  withLabel = false,
  className,
}: {
  einvoice: EInvoiceInfo;
  withLabel?: boolean;
  className?: string;
}) {
  const state = STATE[einvoice.status];
  if (!state) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 rounded border align-middle',
              withLabel ? 'px-1.5 py-0.5' : 'size-[18px] justify-center',
              state.tone,
              className,
            )}
          >
            <span className="font-mono text-[11px] font-bold leading-none">e</span>
            {withLabel && <span className="text-[11px] font-medium">{state.label}</span>}
          </span>
        }
      />
      <TooltipContent className="max-w-xs">
        <p className="font-medium">{state.label}</p>
        <p className="mt-0.5 text-xs opacity-80">{state.detail}</p>
        {einvoice.irn && (
          <p className="mt-1 break-all font-mono text-[10px] opacity-70">IRN {einvoice.irn}</p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/** The companion mark for an e-way bill, which travels with the goods. */
export function EWayMark({ ewbNo, className }: { ewbNo?: string; className?: string }) {
  if (!ewbNo) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              'inline-flex size-[18px] shrink-0 items-center justify-center rounded border border-info/40 bg-info/10 align-middle text-info',
              className,
            )}
          >
            <span className="font-mono text-[10px] font-bold leading-none">eW</span>
          </span>
        }
      />
      <TooltipContent>
        <p className="font-medium">E-way bill generated</p>
        <p className="mt-0.5 font-mono text-[10px] opacity-70">{ewbNo}</p>
      </TooltipContent>
    </Tooltip>
  );
}
