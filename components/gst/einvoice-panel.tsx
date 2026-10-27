'use client';

// The invoice's own e-invoice status, and the two things worth doing from
// here: checking whether the portal would accept it, and registering it.
//
// The check costs nothing and files nothing. It runs the same rules that run
// before every submission and answers in field-level words, "line 2 has no HSN
// code", rather than the portal's error codes, so a problem is fixed before an
// attempt is spent on it.

import { useState } from 'react';
import Link from 'next/link';
import { FileCheck2, Loader2, SearchCheck, TriangleAlert, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { gst, type EinvoicePreviewResponse, type InvoiceDetail } from '@/lib/api/client';
import { useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { timeLeft } from '@/lib/tax/einvoice';
import { cn } from '@/lib/utils';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "12 Sep 2026, 14:02" in Indian time, as the portal reports it. */
function istTime(iso: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return `${p.day} ${MONTHS[Number(p.month) - 1]} ${p.year}, ${p.hour}:${p.minute}`;
}

/** "14:32" in Indian time. */
const clock = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(
    new Date(iso),
  );

const PROVIDER_NAMES: Record<string, string> = {
  fake: 'the built-in stand-in',
  nic_einvoice: 'the NIC e-invoice API',
};

const ENVIRONMENT_NOTE: Record<string, string> = {
  'stand-in': 'Issued by the built-in stand-in. It is not registered with the government portal.',
  sandbox: 'A NIC sandbox test registration. Nothing was filed.',
  production: 'Registered with the Invoice Registration Portal.',
};

/** Days left of the 30-day window, counted the way the register counts them. */
function windowDaysLeft(invoiceDate: string): number {
  const today = Date.parse(new Date().toISOString().slice(0, 10));
  return 30 - Math.floor((today - Date.parse(invoiceDate.slice(0, 10))) / 86_400_000);
}

export function EinvoicePanel({ inv, onChanged }: { inv: InvoiceDetail; onChanged: () => void }) {
  const canFile = usePermission('gst', 'approve');
  const preview = useApiAction(gst.einvoicePreview);
  const submit = useApiAction(gst.submitEinvoice);
  const [check, setCheck] = useState<EinvoicePreviewResponse | null>(null);
  const e = inv.einvoice;

  if (e.status === 'not_applicable') return null;

  const runCheck = async () => {
    const result = await preview.run(inv.id);
    if (result) setCheck(result);
  };

  const register = async () => {
    const done = await submit.run(inv.id);
    if (!done) {
      toast.error(`${inv.number} was not registered`, { description: submit.error ?? undefined });
      return;
    }
    toast.success(`IRN generated for ${inv.number}`, {
      description:
        [
          done.live ? null : 'Nothing was filed: this went to the stand-in or a sandbox, not the live portal.',
          done.ewayBillNo ? `E-way bill ${done.ewayBillNo} was issued with it.` : null,
          ...done.warnings,
        ]
          .filter(Boolean)
          .join(' ') || undefined,
    });
    setCheck(null);
    onChanged();
  };

  // ── Registered ─────────────────────────────────────────────────────────────
  if (e.status === 'submitted') {
    return (
      <Card className="flex flex-wrap items-start gap-x-6 gap-y-2 p-4 text-sm" data-slot="einvoice-panel">
        <FileCheck2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium">E-invoice registered</p>
          <p className="break-all font-mono text-[11px] text-muted-foreground">IRN {e.irn}</p>
          <p className="text-xs text-muted-foreground">
            {[e.ackNo ? `Ack no. ${e.ackNo}` : null, e.ackDate ? istTime(e.ackDate) : null].filter(Boolean).join(' · ')}
          </p>
          {e.environment && (
            <p className={cn('text-xs', e.environment === 'production' ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-300')}>
              {ENVIRONMENT_NOTE[e.environment]}
            </p>
          )}
        </div>
        <div className="space-y-1 text-right text-xs text-muted-foreground">
          {e.cancelUntil ? <p>Can be cancelled for {timeLeft(e.cancelUntil)} more</p> : <p>Past the 24-hour cancellation window</p>}
          <Link href={`/sales/invoices/${inv.id}/print`} className="font-medium text-primary hover:underline">
            Print the tax invoice
          </Link>
        </div>
      </Card>
    );
  }

  // ── Cancelled ──────────────────────────────────────────────────────────────
  if (e.status === 'cancelled') {
    return (
      <Card className="flex items-start gap-3 p-4 text-sm" data-slot="einvoice-panel">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div>
          <p className="font-medium">IRN cancelled{e.cancelledAt ? ` on ${istTime(e.cancelledAt)}` : ''}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {e.cancelReason ? `${e.cancelReason}. ` : ''}The portal will not accept this invoice number again; a
            sale that stands needs a fresh invoice.
          </p>
        </div>
      </Card>
    );
  }

  // ── Awaiting an IRN ────────────────────────────────────────────────────────
  const daysLeft = windowDaysLeft(inv.date);
  const provider = check ? PROVIDER_NAMES[check.provider] ?? check.provider : null;

  return (
    <Card className="space-y-3 p-4 text-sm" data-slot="einvoice-panel">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <TriangleAlert className={cn('mt-0.5 size-4 shrink-0', daysLeft < 0 ? 'text-destructive' : 'text-amber-600')} />
        <div className="min-w-0 flex-1">
          <p className="font-medium">E-invoice: awaiting an IRN</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            A B2B invoice above the turnover threshold is not valid without one.{' '}
            {daysLeft >= 0
              ? `${daysLeft} day${daysLeft === 1 ? '' : 's'} left in the 30-day window.`
              : `${-daysLeft} days past the 30-day window: the portal will refuse it, and a credit note and fresh invoice are the remedy.`}
          </p>
          {e.status === 'failed' && e.errorMessage && (
            <p className="mt-1 text-xs text-destructive">Last attempt: {e.errorMessage}</p>
          )}
          {e.retry && (
            <p className="mt-1 text-xs text-muted-foreground" data-slot="einvoice-retry">
              The portal did not answer. The app will try again on its own at {clock(e.retry.at)} (try{' '}
              {e.retry.attempt} of {e.retry.of}).
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="gap-1.5" disabled={preview.busy} onClick={() => void runCheck()} data-slot="einvoice-check-button">
            {preview.busy ? <Loader2 className="size-3.5 animate-spin" /> : <SearchCheck className="size-3.5" />}
            Check before registering
          </Button>
          {canFile && inv.status !== 'draft' && (
            <Button size="sm" className="gap-1.5" disabled={submit.busy} onClick={() => void register()} data-slot="einvoice-register-button">
              {submit.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}
              Register now
            </Button>
          )}
        </div>
      </div>

      {preview.error && <p className="text-xs text-destructive">{preview.error}</p>}

      {check && (
        <div className="space-y-2 border-t pt-3" data-slot="einvoice-check">
          {check.preflight.ok ? (
            <p className="font-medium text-emerald-700 dark:text-emerald-400">
              Ready: nothing here the portal would refuse.
            </p>
          ) : (
            <p className="font-medium text-destructive">
              {check.preflight.errors.length} thing{check.preflight.errors.length === 1 ? '' : 's'} the portal would
              refuse
            </p>
          )}
          {check.preflight.errors.length > 0 && (
            <ul className="space-y-1">
              {check.preflight.errors.map((p) => (
                <li key={`${p.field}:${p.message}`} className="grid gap-x-3 sm:grid-cols-[10rem_1fr]">
                  <span className="font-mono text-[11px] text-muted-foreground">{p.field}</span>
                  <span>{p.message}</span>
                </li>
              ))}
            </ul>
          )}
          {check.preflight.warnings.length > 0 && (
            <>
              <p className="pt-1 text-xs font-medium text-amber-700 dark:text-amber-300">Accepted, but worth fixing</p>
              <ul className="space-y-1 text-xs">
                {check.preflight.warnings.map((p) => (
                  <li key={`${p.field}:${p.message}`} className="grid gap-x-3 sm:grid-cols-[10rem_1fr]">
                    <span className="font-mono text-[11px] text-muted-foreground">{p.field}</span>
                    <span className="text-muted-foreground">{p.message}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="text-xs text-muted-foreground">
            {check.connected
              ? `It would go to ${provider}${check.live ? '.' : ', which files nothing.'}`
              : 'No portal connection is set up for this branch, so the built-in stand-in would answer and nothing would be filed.'}
          </p>
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Show what would be sent</summary>
            <pre className="mt-2 max-h-72 overflow-auto rounded-[3px] border bg-muted/40 p-2 text-[11px] leading-relaxed">
              {JSON.stringify(check.payload, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </Card>
  );
}
