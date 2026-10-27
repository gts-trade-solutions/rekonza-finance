'use client';

// The pieces around the conversation: what is left to spend, and the one
// decision an admin has to make before anyone can ask anything.

import Link from 'next/link';
import { useState } from 'react';
import { Loader2, ShieldCheck, Sparkles, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { ai, type AiStatus } from '@/lib/api/ai';
import {
  MC_PER_CREDIT, REPORT_DOWNLOAD_CREDITS, REPORT_MARKUP_PCT, TRIAL_CREDITS, TRIAL_DAYS, formatCredits,
} from '@/lib/billing/catalog';
import { cn } from '@/lib/utils';
import { useCredits } from './credits-provider';

const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

/** "312.4 credits · Growth plan" — and a way to get more, for those who can buy. */
export function CreditMeter({ status }: { status: AiStatus }) {
  const credits = useCredits();
  // The shell's balance is live; the status is what the page loaded with.
  const availableMc = credits.wallet?.availableMc ?? status.wallet.availableMc;
  const low = availableMc < 10 * MC_PER_CREDIT;
  const empty = availableMc < MC_PER_CREDIT;
  const detail = status.isDemo
    ? 'Demo allowance · resets daily'
    : status.plan
      ? `${status.plan.name} plan${status.plan.status !== 'active' ? ` · ${status.plan.status}` : ''}`
      : status.wallet.trialExpiresAt
        ? `Trial · ends ${day(status.wallet.trialExpiresAt)}`
        : 'Pay as you go';

  return (
    <div className="flex items-center gap-2" data-slot="ai-credit-meter">
      <div
        className={cn(
          'flex items-center gap-2 rounded-md border px-3 py-1.5',
          empty ? 'border-destructive/40 bg-destructive/5' : low ? 'border-warning/40 bg-warning/5' : 'bg-card',
        )}
      >
        <Wallet className={cn('size-4', empty ? 'text-destructive' : low ? 'text-warning' : 'text-primary')} />
        <div className="leading-tight">
          <p className="text-sm font-semibold tabular-nums">
            {formatCredits(availableMc)} <span className="font-normal text-muted-foreground">credits</span>
          </p>
          <p className="text-[11px] text-muted-foreground">{detail}</p>
        </div>
      </div>
      {status.canManage && (
        <>
          <Button size="sm" variant={low ? 'default' : 'outline'} onClick={credits.topUp} data-slot="ai-topup">
            <Wallet className="size-3.5" /> Top up
          </Button>
          <Button size="sm" variant="ghost" asChild>
            <Link href="/settings/billing">Plans</Link>
          </Button>
        </>
      )}
    </div>
  );
}

/**
 * The admin's decision. What is sent, to whom, and what it costs, said plainly
 * before the switch — and the switch does nothing until the box is ticked.
 */
export function EnablePanel({ orgName, onEnabled }: { orgName: string; onEnabled: () => void }) {
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);

  const enable = async () => {
    setBusy(true);
    try {
      const res = await ai.settings({ enabled: true, acceptDataTerms: true });
      toast.success(
        res.trialGrantedMc ? `The assistant is on, with ${formatCredits(res.trialGrantedMc)} free credits to start.` : 'The assistant is on.',
      );
      onEnabled();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mx-auto max-w-2xl space-y-5 p-6" data-slot="ai-enable">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
          <Sparkles className="size-5" />
        </span>
        <div>
          <h2 className="text-base font-semibold">Turn on the AI assistant for {orgName}</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            Ask about your books in plain words — closing balances, profit, cash, who owes you, GST — and get answers
            built from the same reports the app shows, each linked back to its source.
          </p>
        </div>
      </div>

      <ul className="space-y-2.5 text-sm">
        <li className="flex gap-2.5">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
          <span>
            <span className="font-medium">What is sent.</span> Each question, and the figures needed to answer it — balances,
            totals, customer and supplier names — go to OpenAI to write the answer. Passwords, portal credentials and bank
            logins are never sent.
          </span>
        </li>
        <li className="flex gap-2.5">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
          <span>
            <span className="font-medium">How it is used.</span> Through OpenAI&apos;s business API, whose terms say API data is
            not used to train their models. Conversations are kept in your book, visible only to the person who asked, and can
            be deleted at any time.
          </span>
        </li>
        <li className="flex gap-2.5">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
          <span>
            <span className="font-medium">It only reads.</span> The assistant cannot create, change or delete anything, and each
            person sees only what their role already allows.
          </span>
        </li>
        <li className="flex gap-2.5">
          <Wallet className="mt-0.5 size-4 shrink-0 text-primary" />
          <span>
            <span className="font-medium">What it costs.</span> Questions use credits — usually one to three each. You start with{' '}
            {TRIAL_CREDITS} free credits for {TRIAL_DAYS} days; after that, a plan or a top-up pack. An answer that comes with a
            chart and a detailed report costs about {REPORT_MARKUP_PCT}% more. Your first report download is free; after that,{' '}
            {REPORT_DOWNLOAD_CREDITS} credit for each new report.
          </span>
        </li>
      </ul>

      <label className="flex cursor-pointer items-start gap-2.5 rounded-md border p-3 text-sm">
        <Checkbox checked={agreed} onCheckedChange={(v) => setAgreed(!!v)} className="mt-0.5" data-slot="ai-consent" />
        <span>
          I agree, on behalf of {orgName}, that questions and the figures needed to answer them may be processed by OpenAI
          as described above.
        </span>
      </label>

      <Button onClick={() => void enable()} disabled={!agreed || busy} data-slot="ai-enable-button">
        {busy && <Loader2 className="size-4 animate-spin" />}
        Turn on the assistant
      </Button>
    </Card>
  );
}

export function NotEnabledPanel() {
  return (
    <Card className="mx-auto flex max-w-xl flex-col items-center gap-3 p-8 text-center">
      <Sparkles className="size-7 text-muted-foreground" />
      <div>
        <p className="font-medium">The assistant is not turned on yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          An administrator decides whether questions can be sent to the AI service. Ask them to turn it on under Settings
          → Billing &amp; AI.
        </p>
      </div>
    </Card>
  );
}

export function UnconfiguredPanel() {
  return (
    <Card className="mx-auto flex max-w-xl flex-col items-center gap-3 p-8 text-center">
      <Sparkles className="size-7 text-muted-foreground" />
      <div>
        <p className="font-medium">The assistant is not set up on this server</p>
        <p className="mt-1 text-sm text-muted-foreground">
          The AI service key has not been configured yet. Everything else in the app works as normal.
        </p>
      </div>
    </Card>
  );
}
