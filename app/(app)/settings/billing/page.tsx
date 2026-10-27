'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Billing & AI: what the organisation has to spend on the assistant, the plan
// it is on, who has been using it, and the invoices for every payment.
//
// Admins only. The page reads as a statement first — balance, plan, usage —
// and a shop second, because the question an owner opens it with is usually
// "how much have we used", not "what can I buy".
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarClock, FileText, FlaskConical, Info, Loader2, Lock, RefreshCw, Sparkles, TriangleAlert, Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage } from '@/components/shared/async-state';
import { TestCheckoutDialog, usePurchase } from '@/components/billing/purchase';
import { useCredits } from '@/components/ai/credits-provider';
import { UsageChart } from '@/components/billing/usage-chart';
import { ai } from '@/lib/api/ai';
import { billing, type BillingOverview } from '@/lib/api/billing';
import { useApi } from '@/lib/api/use-api';
import {
  REPORT_DOWNLOAD_CREDITS, REPORT_MARKUP_PCT, TYPICAL_CREDITS_PER_QUESTION, formatCredits,
  type BillingPeriod, type PackCode, type PlanCode,
} from '@/lib/billing/catalog';
import { formatINR } from '@/lib/money';
import { usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';

const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const whole = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: paise % 100 ? 2 : 0, minimumFractionDigits: paise % 100 ? 2 : 0 })}`;

const SOURCE_LABEL: Record<string, string> = {
  trial: 'Free trial',
  plan: 'Plan credits',
  topup: 'Top-up',
  demo: 'Demo allowance',
  adjustment: 'Adjustment',
};

const STATUS: Record<string, { label: string; tone: string }> = {
  active: { label: 'Active', tone: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300' },
  authenticated: { label: 'Starting', tone: 'border-primary/40 text-primary' },
  created: { label: 'Awaiting payment', tone: 'border-muted-foreground/30 text-muted-foreground' },
  pending: { label: 'Payment failed · retrying', tone: 'border-warning/50 text-warning' },
  halted: { label: 'Stopped · payment failed', tone: 'border-destructive/40 text-destructive' },
  paused: { label: 'Paused', tone: 'border-muted-foreground/30 text-muted-foreground' },
  cancelled: { label: 'Cancelled', tone: 'border-muted-foreground/30 text-muted-foreground' },
};

const PAYMENT_STATUS: Record<string, { label: string; tone: string }> = {
  paid: { label: 'Paid', tone: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300' },
  created: { label: 'Awaiting payment', tone: 'border-muted-foreground/30 text-muted-foreground' },
  abandoned: { label: 'Not completed', tone: 'border-muted-foreground/30 text-muted-foreground' },
  failed: { label: 'Failed', tone: 'border-destructive/40 text-destructive' },
  refunded: { label: 'Refunded', tone: 'border-muted-foreground/30 text-muted-foreground' },
  partially_refunded: { label: 'Part refunded', tone: 'border-warning/50 text-warning' },
};

export default function BillingPage() {
  const canView = usePermission('billing', 'view');
  const credits = useCredits();
  const state = useApi<BillingOverview>(() => billing.overview(), []);
  const { refetch } = state;

  // The balance moved somewhere else — a top-up bought from the top bar, a
  // question asked in the corner panel — so the statement here follows it.
  const walletMc = credits.wallet?.availableMc;
  const shownMc = useRef(walletMc);
  useEffect(() => {
    if (walletMc === undefined) return;
    const before = shownMc.current;
    shownMc.current = walletMc;
    if (before !== undefined && before !== walletMc) void refetch();
  }, [walletMc, refetch]);

  // And the other way: a purchase, a plan or the assistant turned off here
  // moves the balance in the top bar and the corner assistant.
  const refresh = () => {
    void refetch();
    void credits.refresh();
  };

  return (
    <>
      <PageHeader
        title="Billing & AI"
        description="Credits for the AI assistant, the plan you are on, who has used it, and an invoice for every payment. Nothing here affects the rest of the app."
        actions={
          <>
            {credits.wallet?.canManage && (
              <Button size="sm" onClick={credits.topUp} data-slot="billing-buy-credits">
                <Wallet className="size-3.5" /> Buy credits
              </Button>
            )}
            <Button variant="outline" size="sm" asChild>
              <Link href="/ai">
                <Sparkles className="size-3.5" /> Open the assistant
              </Link>
            </Button>
          </>
        }
      />
      {!canView ? (
        <Card className="flex items-center gap-3 p-6">
          <Lock className="size-5 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Billing is managed by your organisation&apos;s administrators.</p>
        </Card>
      ) : (
        <AsyncPage state={state}>{(d) => <Billing d={d} refresh={refresh} />}</AsyncPage>
      )}
    </>
  );
}

function Billing({ d, refresh }: { d: BillingOverview; refresh: () => void }) {
  const purchase = usePurchase(refresh);
  const [period, setPeriod] = useState<BillingPeriod>(d.subscription?.period ?? 'monthly');
  const [confirm, setConfirm] = useState<null | { kind: 'cancel' } | { kind: 'change'; plan: PlanCode }>(null);
  const [acting, setActing] = useState(false);
  const canBuy = !d.isDemo && d.mode !== 'disabled' && d.blocking.length === 0;
  const sub = d.subscription;

  const runAction = async (fn: () => Promise<string>) => {
    setActing(true);
    try {
      toast.success(await fn());
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setActing(false);
      setConfirm(null);
    }
  };

  const renew = () =>
    runAction(async () => (await billing.standin({ step: 'renew' })).message);

  return (
    <div className="space-y-6">
      {/* ── What this server can do ── */}
      {d.isDemo && (
        <Notice tone="info" icon={Info}>
          This is the shared demo book. It gets a fresh AI allowance every day, and nothing can be bought here — create
          your own book to choose a plan.
        </Notice>
      )}
      {!d.isDemo && d.mode === 'standin' && (
        <Notice tone="warning" icon={FlaskConical}>
          <span className="font-medium">Test checkout.</span> No payment gateway is configured on this server, so purchases
          go through a built-in stand-in and nothing is charged. Set the Razorpay keys to take real payments.
        </Notice>
      )}
      {!d.isDemo && d.mode === 'disabled' && (
        <Notice tone="warning" icon={TriangleAlert}>
          Online payments are not set up on this server yet, so credits cannot be bought. Existing credits can still be used.
        </Notice>
      )}
      {d.blocking.map((b) => (
        <Notice key={b} tone="danger" icon={TriangleAlert}>
          {b}
        </Notice>
      ))}
      {!d.isDemo && d.warnings.map((w) => (
        <Notice key={w} tone="info" icon={Info}>
          {w}
        </Notice>
      ))}

      {/* ── The statement ── */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-5" data-slot="billing-credits">
          <p className="micro-label">Credits available</p>
          <p className="mt-2 text-3xl font-semibold tabular-nums">{formatCredits(d.wallet.availableMc)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            About {Math.floor(d.wallet.availableMc / 1000 / TYPICAL_CREDITS_PER_QUESTION).toLocaleString('en-IN')} questions
            {d.wallet.heldMc > 0 ? ` · ${formatCredits(d.wallet.heldMc)} reserved by questions in progress` : ''}
          </p>
          <div className="mt-4 space-y-2">
            {d.wallet.buckets.length === 0 ? (
              <p className="text-xs text-muted-foreground">No credits yet.</p>
            ) : (
              d.wallet.buckets.map((b) => (
                <div key={b.id} className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="min-w-0">
                    <span className="font-medium">{SOURCE_LABEL[b.source] ?? b.source}</span>
                    <span className="block truncate text-muted-foreground">
                      {b.expiresAt ? `Expires ${day(b.expiresAt)}` : 'Does not expire'}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums">{formatCredits(b.remainingMc)}</span>
                </div>
              ))
            )}
          </div>
        </Card>

        <Card className="p-5" data-slot="billing-plan">
          <p className="micro-label">Plan</p>
          {sub ? (
            <>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <p className="text-xl font-semibold">{sub.planName}</p>
                <Badge variant="outline" className={cn('text-[10px]', STATUS[sub.status]?.tone)}>
                  {sub.cancelAtPeriodEnd && sub.status === 'active' ? 'Ends at period end' : STATUS[sub.status]?.label ?? sub.status}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {formatINR(sub.amountPaise)} a {sub.period === 'yearly' ? 'year' : 'month'}, GST included
              </p>
              <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                <CalendarClock className="size-3.5" />
                {sub.status === 'active'
                  ? sub.cancelAtPeriodEnd
                    ? `Ends ${day(sub.currentEnd)} — credits stay usable until then`
                    : `Renews ${day(sub.currentEnd)}`
                  : sub.status === 'pending'
                    ? 'The last renewal payment failed. Razorpay is retrying it.'
                    : sub.status === 'halted'
                      ? 'Renewal payments failed and the plan has stopped.'
                      : 'Waiting for the first payment.'}
              </p>
              {sub.pendingPlanCode && (
                <p className="mt-1 text-xs text-primary">
                  Switches to {d.catalog.plans.find((p) => p.code === sub.pendingPlanCode)?.name} on {day(sub.currentEnd)}
                </p>
              )}
              {(sub.status === 'pending' || sub.status === 'halted') && sub.shortUrl && (
                <Button size="sm" className="mt-3" asChild>
                  <a href={sub.shortUrl} target="_blank" rel="noopener noreferrer">
                    Update the payment method
                  </a>
                </Button>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                {sub.status === 'active' && !sub.cancelAtPeriodEnd && (
                  <Button size="sm" variant="outline" onClick={() => setConfirm({ kind: 'cancel' })} data-slot="cancel-plan">
                    Cancel plan
                  </Button>
                )}
                {d.mode === 'standin' && sub.provider === 'standin' && sub.status === 'active' && (
                  <Button size="sm" variant="outline" onClick={() => void renew()} disabled={acting} data-slot="simulate-renewal">
                    <RefreshCw className="size-3.5" /> Simulate the next renewal
                  </Button>
                )}
              </div>
            </>
          ) : (
            <>
              <p className="mt-2 text-xl font-semibold">Pay as you go</p>
              <p className="mt-1 text-sm text-muted-foreground">
                No plan. Choose one below for credits every month at a lower price, or buy a top-up pack.
              </p>
            </>
          )}
        </Card>

        <Card className="p-5" data-slot="billing-month">
          <p className="micro-label">This month</p>
          <p className="mt-2 text-3xl font-semibold tabular-nums">{formatCredits(d.usage.monthMc)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            credits across {d.usage.monthQuestions.toLocaleString('en-IN')} question{d.usage.monthQuestions === 1 ? '' : 's'}
            {d.usage.monthQuestions ? ` · ${formatCredits(Math.round(d.usage.monthMc / d.usage.monthQuestions))} each on average` : ''}
          </p>
          <div className="mt-4 space-y-1.5">
            {d.usage.byUser.slice(0, 4).map((u) => (
              <div key={u.userId} className="flex justify-between gap-3 text-xs">
                <span className="truncate">{u.name}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {formatCredits(u.creditsMc)} · {u.questions} q
                </span>
              </div>
            ))}
            {d.usage.byUser.length === 0 && <p className="text-xs text-muted-foreground">Nobody has asked anything yet this month.</p>}
          </div>
        </Card>
      </div>

      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">Credits used, last 30 days</h3>
          <p className="text-xs text-muted-foreground">
            Each question is charged for the tokens it actually used, plus {REPORT_MARKUP_PCT}% when it comes with a detailed
            report. Report downloads: each person&apos;s first is free, then {REPORT_DOWNLOAD_CREDITS} credit per report.
          </p>
        </div>
        <UsageChart days={d.usage.days} />
      </Card>

      {/* ── Buying ── */}
      {!d.isDemo && (
        <>
          <Card className="p-5" data-slot="billing-plans">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">Plans</h3>
                <p className="text-xs text-muted-foreground">
                  Credits every month, at a lower price than top-ups. Prices are before {d.gstRatePct}% GST.
                </p>
              </div>
              <div className="inline-flex rounded-md border p-0.5 text-xs" role="radiogroup" aria-label="Billing period">
                {(['monthly', 'yearly'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={period === p}
                    onClick={() => setPeriod(p)}
                    className={cn(
                      'rounded px-3 py-1 font-medium transition-colors',
                      period === p ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {p === 'monthly' ? 'Monthly' : 'Yearly · 2 months free'}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              {d.catalog.plans.map((p) => {
                const price = period === 'yearly' ? p.yearlyPaise : p.monthlyPaise;
                const withGst = period === 'yearly' ? p.yearlyWithGstPaise : p.monthlyWithGstPaise;
                const perCredit = price / (p.creditsPerMonth * (period === 'yearly' ? 12 : 1));
                const current = sub?.planCode === p.code && sub.period === period && sub.status === 'active';
                const switching = sub?.pendingPlanCode === p.code;
                const blockedByPeriod = !!sub && sub.status === 'active' && sub.period !== period;
                return (
                  <div
                    key={p.code}
                    className={cn('flex flex-col rounded-md border p-4', current && 'border-primary ring-1 ring-primary')}
                    data-slot="plan-card"
                    data-plan={p.code}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold">{p.name}</p>
                      {current && <Badge className="text-[10px]">Current</Badge>}
                      {switching && <Badge variant="outline" className="text-[10px]">From next renewal</Badge>}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{p.tagline}</p>
                    <p className="mt-3 text-2xl font-semibold tabular-nums">
                      {whole(price)}
                      <span className="text-sm font-normal text-muted-foreground">/{period === 'yearly' ? 'year' : 'month'}</span>
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {formatINR(withGst)} with GST · ₹{(perCredit / 100).toFixed(2)} a credit
                    </p>
                    <ul className="mt-3 flex-1 space-y-1 text-xs">
                      {p.highlights.map((h) => (
                        <li key={h} className="flex gap-1.5">
                          <span className="text-primary">•</span> {h}
                        </li>
                      ))}
                    </ul>
                    <div className="mt-4">
                      {current ? (
                        <Button size="sm" variant="outline" className="w-full" disabled>
                          Your plan
                        </Button>
                      ) : sub && sub.status === 'active' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full"
                          disabled={blockedByPeriod || switching || sub.cancelAtPeriodEnd || acting}
                          title={blockedByPeriod ? 'To change how often you are billed, cancel the current plan and choose again when it ends.' : undefined}
                          onClick={() => setConfirm({ kind: 'change', plan: p.code })}
                        >
                          {switching ? 'Scheduled' : 'Switch at renewal'}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          className="w-full"
                          disabled={!canBuy || !!purchase.busy || (!!sub && sub.status !== 'created')}
                          onClick={() => void purchase.subscribe(p.code, period)}
                          data-slot="choose-plan"
                        >
                          {purchase.busy === `plan:${p.code}` && <Loader2 className="size-3.5 animate-spin" />}
                          Choose {p.name}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              Plan credits arrive at the start of each month of the plan and do not carry over. Plans renew automatically
              through Razorpay until cancelled; cancelling keeps the plan until the end of the period already paid for.
            </p>
          </Card>

          <Card className="p-5" data-slot="billing-packs">
            <div className="mb-4">
              <h3 className="text-sm font-semibold">Top-up packs</h3>
              <p className="text-xs text-muted-foreground">
                One-off credits, no plan needed. Valid for {d.catalog.topupValidityDays} days, and used after any plan credits
                that expire sooner.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {d.catalog.packs.map((p) => (
                <div key={p.code} className="flex flex-col rounded-md border p-4" data-slot="pack-card" data-pack={p.code}>
                  <p className="text-lg font-semibold tabular-nums">{p.credits.toLocaleString('en-IN')} credits</p>
                  <p className="text-xs text-muted-foreground">
                    About {Math.floor(p.credits / TYPICAL_CREDITS_PER_QUESTION).toLocaleString('en-IN')} questions
                  </p>
                  <p className="mt-3 text-xl font-semibold tabular-nums">{whole(p.pricePaise)}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {formatINR(p.withGstPaise)} with GST · ₹{(p.pricePaise / p.credits / 100).toFixed(2)} a credit
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-4"
                    disabled={!canBuy || !!purchase.busy}
                    onClick={() => void purchase.buyPack(p.code as PackCode)}
                    data-slot="buy-pack"
                  >
                    {purchase.busy === `pack:${p.code}` && <Loader2 className="size-3.5 animate-spin" />}
                    Buy
                  </Button>
                </div>
              ))}
            </div>
          </Card>

          <AiSettingsCard d={d} onChanged={refresh} />
        </>
      )}

      {/* ── The record ── */}
      <Card className="overflow-hidden p-0" data-slot="billing-payments">
        <div className="border-b px-5 py-3">
          <h3 className="text-sm font-semibold">Payments and invoices</h3>
        </div>
        <div className="overflow-x-auto thin-scroll">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Date</th>
                <th className="px-4 py-2 font-medium">What</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Invoice</th>
              </tr>
            </thead>
            <tbody>
              {d.payments.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No payments yet.
                  </td>
                </tr>
              ) : (
                d.payments.map((p) => (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs">{day(p.paidAt ?? p.createdAt)}</td>
                    <td className="px-4 py-2.5">
                      <p className="text-sm">{p.description}</p>
                      {p.failureReason && <p className="text-xs text-destructive">{p.failureReason}</p>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">{formatINR(p.amountPaise)}</td>
                    <td className="px-4 py-2.5">
                      <Badge variant="outline" className={cn('text-[10px]', PAYMENT_STATUS[p.status]?.tone)}>
                        {PAYMENT_STATUS[p.status]?.label ?? p.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5">
                      {p.invoiceId ? (
                        <Link href={`/settings/billing/invoices/${p.invoiceId}`} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                          <FileText className="size-3.5" /> {p.invoiceNumber}
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <TestCheckoutDialog pending={purchase.testCheckout} onClose={purchase.closeTestCheckout} onDone={refresh} />

      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          {confirm?.kind === 'cancel' ? (
            <>
              <DialogHeader>
                <DialogTitle>Cancel the {sub?.planName} plan?</DialogTitle>
                <DialogDescription>
                  It stays active until {day(sub?.currentEnd ?? null)}, and this month&apos;s credits stay usable until then.
                  After that it will not renew, and nothing more is charged. Top-up credits are not affected.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirm(null)}>
                  Keep the plan
                </Button>
                <Button
                  variant="destructive"
                  disabled={acting}
                  onClick={() =>
                    void runAction(async () => {
                      const r = await billing.cancel();
                      return r.endsAt ? `The plan will end on ${day(r.endsAt)}.` : 'The plan was cancelled.';
                    })
                  }
                  data-slot="confirm-cancel"
                >
                  Cancel at period end
                </Button>
              </DialogFooter>
            </>
          ) : confirm?.kind === 'change' ? (
            <>
              <DialogHeader>
                <DialogTitle>Switch to {d.catalog.plans.find((p) => p.code === confirm.plan)?.name}?</DialogTitle>
                <DialogDescription>
                  The change takes effect at your next renewal on {day(sub?.currentEnd ?? null)}, at the new plan&apos;s price.
                  Until then nothing changes. Need more credits before that? Buy a top-up pack.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirm(null)}>
                  Not now
                </Button>
                <Button
                  disabled={acting}
                  onClick={() =>
                    void runAction(async () => {
                      await billing.changePlan(confirm.plan);
                      return 'The plan will switch at the next renewal.';
                    })
                  }
                >
                  Switch at renewal
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AiSettingsCard({ d, onChanged }: { d: BillingOverview; onChanged: () => void }) {
  const [cap, setCap] = useState(d.settings.userMonthlyCapMc ? String(d.settings.userMonthlyCapMc / 1000) : '');
  const [busy, setBusy] = useState(false);
  useEffect(() => setCap(d.settings.userMonthlyCapMc ? String(d.settings.userMonthlyCapMc / 1000) : ''), [d.settings.userMonthlyCapMc]);
  const capValue = useMemo(() => (cap.trim() ? Math.floor(Number(cap)) : null), [cap]);
  const capValid = capValue === null || (Number.isInteger(capValue) && capValue >= 1);

  const save = async (input: Parameters<typeof ai.settings>[0], done: string) => {
    setBusy(true);
    try {
      await ai.settings(input);
      toast.success(done);
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-5 p-5" data-slot="billing-ai-settings">
      <div>
        <h3 className="text-sm font-semibold">Assistant settings</h3>
        <p className="text-xs text-muted-foreground">Who can use the assistant, and how much.</p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{d.settings.enabled ? 'The assistant is on' : 'The assistant is off'}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {d.settings.consentAt
              ? `Data processing agreed by ${d.settings.consentBy ?? 'an administrator'} on ${day(d.settings.consentAt)}.`
              : 'Turning it on asks you to agree to how questions are processed.'}
          </p>
        </div>
        {d.settings.enabled ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void save({ enabled: false }, 'The assistant is off.')}>
            Turn off
          </Button>
        ) : (
          <Button size="sm" asChild>
            <Link href="/ai">Turn on</Link>
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[14rem] flex-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="user-cap">
            Monthly limit per person (credits)
          </label>
          <Input
            id="user-cap"
            inputMode="numeric"
            value={cap}
            onChange={(e) => setCap(e.target.value.replace(/[^\d]/g, ''))}
            placeholder="No limit"
            className="mt-1.5"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            Stops one person using up the organisation&apos;s credits. Resets on the 1st of each month.
          </p>
        </div>
        <Button
          size="sm"
          disabled={busy || !capValid || capValue === (d.settings.userMonthlyCapMc ? d.settings.userMonthlyCapMc / 1000 : null)}
          onClick={() => void save({ monthlyCapCredits: capValue }, capValue === null ? 'Limit removed.' : `Limit set to ${capValue} credits a month.`)}
        >
          Save limit
        </Button>
      </div>
    </Card>
  );
}

function Notice({
  tone,
  icon: Icon,
  children,
}: {
  tone: 'info' | 'warning' | 'danger';
  icon: typeof Info;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-md border px-4 py-3 text-sm',
        tone === 'danger'
          ? 'border-destructive/40 bg-destructive/5 text-destructive'
          : tone === 'warning'
            ? 'border-warning/40 bg-warning/5'
            : 'bg-card text-muted-foreground',
      )}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', tone === 'warning' && 'text-warning')} />
      <p className="leading-relaxed">{children}</p>
    </div>
  );
}
