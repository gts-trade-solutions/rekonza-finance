'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Buying credits, from wherever the balance is shown.
//
// Running out mid-thought and being sent to a settings page to fix it is how a
// feature stops being used. So the packs open over the current screen, and the
// purchase finishes there. Prices come from the server, which is where the GST
// rate is decided, so this dialog and the billing page can never disagree.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Info, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { TestCheckoutDialog, usePurchase } from '@/components/billing/purchase';
import { billing, type BillingOverview } from '@/lib/api/billing';
import { TYPICAL_CREDITS_PER_QUESTION, formatCredits, type PackCode } from '@/lib/billing/catalog';
import { formatINR } from '@/lib/money';
import { cn } from '@/lib/utils';

const whole = (paise: number) => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;

export function TopUpDialog({
  open,
  onOpenChange,
  availableMc,
  onPurchased,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  availableMc: number;
  onPurchased: () => void;
}) {
  const [overview, setOverview] = useState<BillingOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOverview(await billing.overview());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const done = () => {
    void load();
    onPurchased();
  };
  const purchase = usePurchase(done);

  const canBuy = !!overview && !overview.isDemo && overview.mode !== 'disabled' && overview.blocking.length === 0;
  const packs = overview?.catalog.packs ?? [];
  const perCredit = (p: (typeof packs)[number]) => p.pricePaise / p.credits;
  const bestValue = packs.length ? packs.reduce((a, b) => (perCredit(b) < perCredit(a) ? b : a)).code : null;

  const buy = (code: PackCode) => {
    // Razorpay opens its own window over the page. A dialog left open under it
    // would keep the keyboard focus to itself, and the card form could not be
    // typed into.
    onOpenChange(false);
    void purchase.buyPack(code);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-2xl" data-slot="topup-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary" /> Top up AI credits
            </DialogTitle>
            <DialogDescription>
              You have {formatCredits(availableMc)} credits. A typical question uses one to three. Packs need no plan,
              and last {overview?.catalog.topupValidityDays ?? 365} days.
            </DialogDescription>
          </DialogHeader>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {!overview && !error && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading prices…
            </p>
          )}

          {overview && (
            <>
              {!canBuy && (
                <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
                  <Info className="mt-0.5 size-4 shrink-0 text-warning" />
                  <span>
                    {overview.isDemo
                      ? 'The demo book gets a fresh allowance every day, and nothing can be bought here. Create your own book to buy credits.'
                      : overview.mode === 'disabled'
                        ? 'Payments are not set up on this server yet.'
                        : overview.blocking.join(' ')}
                  </span>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-3">
                {packs.map((p) => {
                  const best = p.code === bestValue;
                  return (
                    <div
                      key={p.code}
                      className={cn('flex flex-col rounded-md border p-4', best && 'border-primary/50 bg-primary/[0.03]')}
                      data-slot="topup-pack"
                      data-pack={p.code}
                    >
                      {best && (
                        <span className="mb-1.5 w-fit rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                          Best value
                        </span>
                      )}
                      <p className="text-lg font-semibold tabular-nums">{p.credits.toLocaleString('en-IN')} credits</p>
                      <p className="text-xs text-muted-foreground">
                        About {Math.floor(p.credits / TYPICAL_CREDITS_PER_QUESTION).toLocaleString('en-IN')} questions
                      </p>
                      <p className="mt-3 text-xl font-semibold tabular-nums">{whole(p.pricePaise)}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {formatINR(p.withGstPaise)} with GST · ₹{(perCredit(p) / 100).toFixed(2)} a credit
                      </p>
                      <Button
                        size="sm"
                        variant={best ? 'default' : 'outline'}
                        className="mt-4"
                        disabled={!canBuy || !!purchase.busy}
                        onClick={() => buy(p.code as PackCode)}
                        data-slot="topup-buy"
                      >
                        {purchase.busy === `pack:${p.code}` && <Loader2 className="size-3.5 animate-spin" />}
                        Buy
                      </Button>
                    </div>
                  );
                })}
              </div>

              <p className="text-xs text-muted-foreground">
                Asking every day? A monthly plan costs less a credit.{' '}
                <Link
                  href="/settings/billing"
                  onClick={() => onOpenChange(false)}
                  className="font-medium text-primary hover:underline"
                >
                  Compare plans
                </Link>
              </p>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Outside the dialog on purpose: the test checkout opens after it closes. */}
      <TestCheckoutDialog pending={purchase.testCheckout} onClose={purchase.closeTestCheckout} onDone={done} />
    </>
  );
}
