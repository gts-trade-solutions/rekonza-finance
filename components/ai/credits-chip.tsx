'use client';

// ─────────────────────────────────────────────────────────────────────────────
// The credit balance in the top bar, always in view.
//
// A balance tucked inside the assistant is found only by someone already
// using it, which is why running out used to come as a surprise. Here it sits
// with the rest of the app's chrome: amber when low, red when empty, and one
// click from topping up.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { MessageCircle, Sparkles, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { MC_PER_CREDIT, TYPICAL_CREDITS_PER_QUESTION, formatCredits } from '@/lib/billing/catalog';
import { cn } from '@/lib/utils';
import { useCredits } from './credits-provider';

const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

export function CreditsChip() {
  const { wallet, topUp, setAssistantOpen } = useCredits();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  if (!wallet || !wallet.enabled || wallet.mode === 'unconfigured') return null;

  const empty = wallet.availableMc < MC_PER_CREDIT;
  const low = !empty && wallet.availableMc < 10 * MC_PER_CREDIT;
  const questions = Math.floor(wallet.availableMc / MC_PER_CREDIT / TYPICAL_CREDITS_PER_QUESTION);
  const detail = wallet.isDemo
    ? 'Demo allowance · resets daily'
    : wallet.plan
      ? `${wallet.plan.name} plan${wallet.plan.status !== 'active' ? ` · ${wallet.plan.status}` : ''}`
      : wallet.trialExpiresAt
        ? `Free trial · ends ${day(wallet.trialExpiresAt)}`
        : 'Pay as you go';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`AI credits: ${formatCredits(wallet.availableMc)}`}
        className={cn(
          'flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-[13px] tabular-nums transition-colors hover:bg-accent',
          empty
            ? 'border-destructive/50 bg-destructive/5 text-destructive'
            : low
              ? 'border-warning/50 bg-warning/5 text-warning'
              : 'text-foreground/80',
        )}
        data-slot="credits-chip"
      >
        <Sparkles className="size-3.5" />
        <span className="font-medium">{formatCredits(wallet.availableMc)}</span>
        <span className="hidden text-muted-foreground md:inline">credits</span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0" data-slot="credits-popover">
        <div className="space-y-1 border-b p-4">
          <p className="micro-label">AI credits</p>
          <p className="text-2xl font-semibold tabular-nums">{formatCredits(wallet.availableMc)}</p>
          <p className="text-xs text-muted-foreground">
            {detail} · about {questions.toLocaleString('en-IN')} question{questions === 1 ? '' : 's'}
          </p>
          {empty && <p className="pt-1 text-xs text-destructive">Out of credits: questions are paused until a top-up.</p>}
          {low && <p className="pt-1 text-xs text-warning">Running low.</p>}
        </div>
        <div className="space-y-2 p-3">
          {wallet.canManage ? (
            <Button
              className="w-full"
              onClick={() => {
                setOpen(false);
                topUp();
              }}
              data-slot="credits-topup"
            >
              <Wallet className="size-4" /> Top up credits
            </Button>
          ) : (
            <p className="px-1 text-xs text-muted-foreground">
              {wallet.isDemo
                ? 'The demo book gets a fresh allowance every day.'
                : 'Credits are bought by your administrators. Ask one to top up.'}
            </p>
          )}
          {!pathname?.startsWith('/ai') && (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                setOpen(false);
                setAssistantOpen(true);
              }}
            >
              <MessageCircle className="size-4" /> Ask the assistant
            </Button>
          )}
          {wallet.canManage && (
            <Link
              href="/settings/billing"
              onClick={() => setOpen(false)}
              className="block pt-1 text-center text-xs text-primary hover:underline"
            >
              Plans, usage and invoices
            </Link>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
