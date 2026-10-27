import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The credit wallet.
//
// An organisation's credits are a set of buckets — the trial, each month of a
// plan, each top-up pack — each with its own expiry, and an append-only ledger
// of every movement. The balance is what the unexpired buckets still hold,
// less what questions in flight have reserved.
//
// A question is paid for in two steps, the way a card authorisation works:
//
//   hold     before the model is called, reserve up to the question's cap from
//            what is available. Two questions asked at once each reserve from
//            what the other left, so they can never spend the same credit.
//   settle   after it finishes, charge what its tokens actually cost — never
//            more than was held — and release the rest.
//
// Every write locks the organisation's wallet row first and its buckets second,
// always in that order, so concurrent questions and payments queue rather than
// deadlock. Functions here take the caller's transaction; none opens its own.
//
// Grants are idempotent on a key ('topup:41', 'plan:7:2026-09-12'), which is
// what makes a payment confirmed by both the browser and a webhook — or a
// webhook delivered three times — grant exactly once.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import { ApiError } from '../http';
import { MC_PER_CREDIT, formatCredits, planByCode } from '../../billing/catalog';
import { demoDailyCredits } from '../ai/config';
import type { CallUsage } from '../ai/types';
import {
  addMonthsClamped, formatInstant, istDate, istMidnightAfter, istMonthStart, wholeMonthsBetween,
} from '../ai/time';

export type BucketSource = 'trial' | 'plan' | 'topup' | 'demo' | 'adjustment';

/** A question needs at least one credit available to start. */
export const MIN_START_MC = MC_PER_CREDIT;

/** A reservation older than this belongs to a question whose server went away. */
const STALE_HOLD_MS = 15 * 60_000;

export interface BucketView {
  id: number;
  source: BucketSource;
  grantedMc: number;
  remainingMc: number;
  expiresAt: string | null;
  note: string | null;
}

export interface WalletView {
  /** What the unexpired buckets hold. */
  totalMc: number;
  /** Reserved by questions in flight. */
  heldMc: number;
  /** What a new question can draw on. */
  availableMc: number;
  buckets: BucketView[];
}

const liveBuckets = (ex: Executor, orgId: number, now: Date) =>
  ex
    .selectFrom('ai_credit_buckets')
    .select(['id', 'source', 'granted_mc', 'remaining_mc', 'expires_at', 'note'])
    .where('org_id', '=', orgId)
    .where('remaining_mc', '>', 0)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
    // Soonest to expire first; never-expiring last. This is the spending order.
    .orderBy(sql`expires_at IS NULL`)
    .orderBy('expires_at')
    .orderBy('id');

/** The balance as it stands, without changing anything. */
export async function walletView(ex: Executor, orgId: number, now = new Date()): Promise<WalletView> {
  const [buckets, wallet] = await Promise.all([
    liveBuckets(ex, orgId, now).execute(),
    ex.selectFrom('ai_wallets').select('held_mc').where('org_id', '=', orgId).executeTakeFirst(),
  ]);
  const totalMc = buckets.reduce((t, b) => t + Number(b.remaining_mc), 0);
  const heldMc = Number(wallet?.held_mc ?? 0);
  return {
    totalMc,
    heldMc,
    availableMc: Math.max(0, totalMc - heldMc),
    buckets: buckets.map((b) => ({
      id: b.id,
      source: b.source,
      grantedMc: Number(b.granted_mc),
      remainingMc: Number(b.remaining_mc),
      expiresAt: b.expires_at ? new Date(b.expires_at).toISOString() : null,
      note: b.note,
    })),
  };
}

// ── Locks and the ledger ─────────────────────────────────────────────────────

/**
 * Lock the wallet row, creating it the first time, and return what is held.
 *
 * Lock first, create only when missing. The other way round — INSERT IGNORE,
 * then SELECT … FOR UPDATE — deadlocks whenever two requests prepare the same
 * wallet at once: the ignored insert takes a shared lock on the existing row,
 * both then want it exclusively, and each waits on the other. With the top bar
 * reading the balance on every screen, "at once" is routine.
 */
export async function lockWallet(trx: Trx, orgId: number): Promise<number> {
  const lock = () =>
    trx.selectFrom('ai_wallets').select('held_mc').where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  let row = await lock();
  if (!row) {
    await sql`INSERT IGNORE INTO ai_wallets (org_id, held_mc) VALUES (${orgId}, 0)`.execute(trx);
    row = await lock();
  }
  if (!row) throw new Error(`The AI wallet for organisation ${orgId} could not be created.`);
  return Number(row.held_mc);
}

/**
 * What the ledger says the organisation holds: every bucket's remainder,
 * expired or not. Expired buckets are only emptied when swept, and the sweep
 * records that as its own ledger line — so the running balance in the ledger
 * always adds up, line by line.
 */
async function ledgerBalance(trx: Trx, orgId: number): Promise<number> {
  const { rows } = await sql<{ v: string | number }>`
    SELECT COALESCE(SUM(remaining_mc), 0) AS v FROM ai_credit_buckets WHERE org_id = ${orgId}
  `.execute(trx);
  return Number(rows[0]?.v ?? 0);
}

interface LedgerLine {
  bucketId: number | null;
  kind: 'grant' | 'usage' | 'expiry' | 'refund' | 'adjustment';
  deltaMc: number;
  balanceAfterMc: number;
  usageId?: number | null;
  userId?: number | null;
  note?: string | null;
}

async function writeLedger(trx: Trx, orgId: number, lines: LedgerLine[]): Promise<void> {
  if (!lines.length) return;
  await trx
    .insertInto('ai_credit_ledger')
    .values(
      lines.map((l) => ({
        org_id: orgId,
        bucket_id: l.bucketId,
        kind: l.kind,
        delta_mc: l.deltaMc,
        balance_after_mc: l.balanceAfterMc,
        usage_id: l.usageId ?? null,
        user_id: l.userId ?? null,
        note: l.note?.slice(0, 255) ?? null,
      })),
    )
    .execute();
}

// ── Grants ───────────────────────────────────────────────────────────────────

export interface GrantInput {
  orgId: number;
  source: BucketSource;
  mc: number;
  expiresAt: Date | null;
  /** Unique per organisation. Granting the same key twice grants once. */
  grantKey: string;
  paymentId?: number | null;
  subscriptionId?: number | null;
  note: string;
  userId?: number | null;
}

export async function grantCredits(trx: Trx, g: GrantInput): Promise<{ bucketId: number; created: boolean }> {
  if (!Number.isInteger(g.mc) || g.mc <= 0) throw new Error(`A grant must be a positive number of millicredits, not ${g.mc}.`);
  await lockWallet(trx, g.orgId);

  const existing = await trx
    .selectFrom('ai_credit_buckets')
    .select('id')
    .where('org_id', '=', g.orgId)
    .where('grant_key', '=', g.grantKey)
    .executeTakeFirst();
  if (existing) return { bucketId: existing.id, created: false };

  const before = await ledgerBalance(trx, g.orgId);
  const res = await trx
    .insertInto('ai_credit_buckets')
    .values({
      org_id: g.orgId,
      source: g.source,
      granted_mc: g.mc,
      remaining_mc: g.mc,
      expires_at: g.expiresAt,
      grant_key: g.grantKey.slice(0, 120),
      payment_id: g.paymentId ?? null,
      subscription_id: g.subscriptionId ?? null,
      note: g.note.slice(0, 255),
    })
    .executeTakeFirstOrThrow();
  const bucketId = Number(res.insertId);

  await writeLedger(trx, g.orgId, [
    { bucketId, kind: 'grant', deltaMc: g.mc, balanceAfterMc: before + g.mc, userId: g.userId, note: g.note },
  ]);
  return { bucketId, created: true };
}

/** Today's allowance for the shared demo book, which has nothing to pay with. */
async function ensureDemoAllowance(trx: Trx, orgId: number, now: Date): Promise<void> {
  await grantCredits(trx, {
    orgId,
    source: 'demo',
    mc: Math.round(demoDailyCredits() * MC_PER_CREDIT),
    expiresAt: istMidnightAfter(now),
    grantKey: `demo:${istDate(now)}`,
    note: `Demo allowance for ${formatInstant(now)}`,
  });
}

/**
 * This month's plan credits, granted the first time they are needed.
 *
 * Lazily rather than from a scheduler, and the same way for monthly and yearly
 * plans: a yearly subscription is charged once but its credits arrive a month
 * at a time, and nothing has to run at midnight on the 12th for that to
 * happen. The first question, or the first look at the billing page, in a new
 * month of an active plan grants that month — once, because the key is the
 * month's start date.
 *
 * Only for a subscription Razorpay says is active and whose paid period covers
 * today. A renewal that failed leaves `current_end` in the past, so nothing is
 * granted until the payment goes through.
 */
export async function ensurePlanCredits(trx: Trx, orgId: number, now: Date): Promise<void> {
  const sub = await trx
    .selectFrom('billing_subscriptions')
    .select(['id', 'plan_code', 'current_start', 'current_end'])
    .where('org_id', '=', orgId)
    .where('status', '=', 'active')
    .orderBy('id', 'desc')
    .executeTakeFirst();
  if (!sub?.current_start || !sub.current_end) return;

  const start = new Date(sub.current_start);
  const end = new Date(sub.current_end);
  if (now < start || now >= end) return;
  const plan = planByCode(sub.plan_code);
  if (!plan) return;

  const k = wholeMonthsBetween(start, now);
  const sliceStart = addMonthsClamped(start, k);
  const next = addMonthsClamped(start, k + 1);
  const sliceEnd = next < end ? next : end;

  await grantCredits(trx, {
    orgId,
    source: 'plan',
    mc: plan.creditsPerMonth * MC_PER_CREDIT,
    expiresAt: sliceEnd,
    // The exact instant the month starts, not its date: a plan renewed on the
    // day it began — a trial run, or a cancel-and-resubscribe — would
    // otherwise share a key with its first month and never be granted.
    grantKey: `plan:${sub.id}:${sliceStart.toISOString()}`,
    subscriptionId: sub.id,
    note: `${plan.name} plan · ${formatInstant(sliceStart)} to ${formatInstant(sliceEnd)}`,
  });
}

// ── Housekeeping ─────────────────────────────────────────────────────────────

/** Empty the buckets that have expired, with a ledger line for each. */
async function sweepExpired(trx: Trx, orgId: number, now: Date): Promise<void> {
  const expired = await trx
    .selectFrom('ai_credit_buckets')
    .select(['id', 'remaining_mc', 'note'])
    .where('org_id', '=', orgId)
    .where('remaining_mc', '>', 0)
    .where('expires_at', '<=', now)
    .forUpdate()
    .execute();
  if (!expired.length) return;

  let balance = await ledgerBalance(trx, orgId);
  const lines: LedgerLine[] = [];
  for (const b of expired) {
    const left = Number(b.remaining_mc);
    await trx.updateTable('ai_credit_buckets').set({ remaining_mc: 0 }).where('id', '=', b.id).execute();
    balance -= left;
    lines.push({
      bucketId: b.id,
      kind: 'expiry',
      deltaMc: -left,
      balanceAfterMc: balance,
      note: `Expired unused${b.note ? ` — ${b.note}` : ''}`,
    });
  }
  await writeLedger(trx, orgId, lines);
}

/**
 * Release reservations left by questions that never finished — a server
 * restart mid-answer, a crashed process. Uncharged: with no record of what the
 * model did, the customer is given the benefit of the doubt.
 */
async function releaseStaleHolds(trx: Trx, orgId: number, now: Date, held: number): Promise<number> {
  const stale = await trx
    .selectFrom('ai_usage')
    .select(['id', 'hold_mc'])
    .where('org_id', '=', orgId)
    .where('status', '=', 'held')
    .where('created_at', '<', new Date(now.getTime() - STALE_HOLD_MS))
    .forUpdate()
    .execute();
  if (!stale.length) return held;

  const released = stale.reduce((t, u) => t + Number(u.hold_mc), 0);
  await trx
    .updateTable('ai_usage')
    .set({ status: 'failed', outcome: 'abandoned', error_code: 'abandoned', settled_at: now })
    .where('id', 'in', stale.map((u) => u.id))
    .execute();
  const next = Math.max(0, held - released);
  await trx.updateTable('ai_wallets').set({ held_mc: next }).where('org_id', '=', orgId).execute();
  return next;
}

/**
 * Bring the wallet up to date: lock it, release abandoned reservations, grant
 * whatever is now due, and empty what has expired. Returns what is held.
 */
export async function prepareWallet(
  trx: Trx,
  orgId: number,
  now: Date,
  opts: { isDemo: boolean },
): Promise<number> {
  let held = await lockWallet(trx, orgId);
  held = await releaseStaleHolds(trx, orgId, now, held);
  if (opts.isDemo) await ensureDemoAllowance(trx, orgId, now);
  await ensurePlanCredits(trx, orgId, now);
  await sweepExpired(trx, orgId, now);
  return held;
}

// ── Paying for a question ────────────────────────────────────────────────────

export interface HoldOptions {
  /** The most this question may reserve. */
  capMc: number;
  isDemo: boolean;
  /** The organisation's per-person monthly limit, if it has set one. */
  monthlyCapMc: number | null;
  conversationId?: number | null;
  provider: string;
  model: string;
}

/** Credits one person has spent, or has reserved, since a moment. */
export async function userSpendSince(ex: Executor, orgId: number, userId: number, since: Date): Promise<number> {
  const { rows } = await sql<{ v: string | number }>`
    SELECT COALESCE(SUM(CASE WHEN status = 'held' THEN hold_mc ELSE charged_mc END), 0) AS v
      FROM ai_usage
     WHERE org_id = ${orgId} AND user_id = ${userId} AND created_at >= ${since}
  `.execute(ex);
  return Number(rows[0]?.v ?? 0);
}

export class OutOfCreditsError extends ApiError {
  constructor(availableMc: number) {
    super(
      402,
      availableMc > 0
        ? `Only ${formatCredits(availableMc)} credits are left — not enough for another question. Top up to keep going.`
        : 'Your organisation has no AI credits left. Top up or choose a plan to keep going.',
      'out_of_credits',
    );
  }
}

export async function holdCredits(
  trx: Trx,
  orgId: number,
  userId: number,
  opts: HoldOptions,
  now = new Date(),
): Promise<{ usageId: number; holdMc: number; availableMc: number }> {
  const held = await prepareWallet(trx, orgId, now, { isDemo: opts.isDemo });
  const total = (await liveBuckets(trx, orgId, now).execute()).reduce((t, b) => t + Number(b.remaining_mc), 0);
  const available = total - held;

  if (available < MIN_START_MC) {
    if (opts.isDemo) {
      throw new ApiError(
        402,
        "The demo book's AI allowance for today has been used. Create your own book to keep asking — it comes with free trial credits.",
        'out_of_credits',
      );
    }
    throw new OutOfCreditsError(Math.max(0, available));
  }

  let hold = Math.min(available, opts.capMc);

  if (opts.monthlyCapMc !== null) {
    const spent = await userSpendSince(trx, orgId, userId, istMonthStart(now));
    const left = opts.monthlyCapMc - spent;
    if (left < MIN_START_MC) {
      throw new ApiError(
        429,
        `You have used your monthly AI allowance of ${formatCredits(opts.monthlyCapMc)} credits. It resets on the 1st, or an admin can raise it.`,
        'user_cap_reached',
      );
    }
    hold = Math.min(hold, left);
  }

  await trx.updateTable('ai_wallets').set({ held_mc: held + hold }).where('org_id', '=', orgId).execute();
  const row = await trx
    .insertInto('ai_usage')
    .values({
      org_id: orgId,
      user_id: userId,
      conversation_id: opts.conversationId ?? null,
      status: 'held',
      provider: opts.provider,
      model: opts.model.slice(0, 80),
      hold_mc: hold,
    })
    .executeTakeFirstOrThrow();

  return { usageId: Number(row.insertId), holdMc: hold, availableMc: available - hold };
}

export interface SettleInput {
  /** What the question cost, in millicredits — capped at the hold here. */
  chargeMc: number;
  usage: CallUsage;
  costMicroUsd: number;
  modelCalls: number;
  toolCalls: number;
  outcome: 'answered' | 'stopped' | 'error';
  errorCode?: string | null;
  durationMs: number;
  conversationId?: number | null;
}

/**
 * Charge a question and release the rest of its reservation.
 *
 * Idempotent: a usage row that is no longer held — already settled, or
 * released as abandoned — is left alone, so a retry cannot charge twice.
 */
export async function settleUsage(
  trx: Trx,
  orgId: number,
  usageId: number,
  s: SettleInput,
  now = new Date(),
): Promise<{ chargedMc: number }> {
  const held = await lockWallet(trx, orgId);
  const usage = await trx
    .selectFrom('ai_usage')
    .select(['id', 'status', 'hold_mc', 'user_id'])
    .where('id', '=', usageId)
    .where('org_id', '=', orgId)
    .forUpdate()
    .executeTakeFirst();
  if (!usage || usage.status !== 'held') return { chargedMc: 0 };

  const holdMc = Number(usage.hold_mc);
  const charge = Math.max(0, Math.min(Math.round(s.chargeMc), holdMc));
  let left = charge;

  if (left > 0) {
    const buckets = await liveBuckets(trx, orgId, now).forUpdate().execute();
    let balance = await ledgerBalance(trx, orgId);
    const lines: LedgerLine[] = [];
    for (const b of buckets) {
      if (left <= 0) break;
      const take = Math.min(Number(b.remaining_mc), left);
      await trx
        .updateTable('ai_credit_buckets')
        .set((eb) => ({ remaining_mc: eb('remaining_mc', '-', take) }))
        .where('id', '=', b.id)
        .execute();
      balance -= take;
      left -= take;
      lines.push({ bucketId: b.id, kind: 'usage', deltaMc: -take, balanceAfterMc: balance, usageId, userId: usage.user_id });
    }
    await writeLedger(trx, orgId, lines);
    // Anything still unpaid came from a bucket that expired while the question
    // ran. The reservation was made in good faith, so the gap is ours.
  }

  const charged = charge - left;
  await trx.updateTable('ai_wallets').set({ held_mc: Math.max(0, held - holdMc) }).where('org_id', '=', orgId).execute();
  await trx
    .updateTable('ai_usage')
    .set({
      status: s.outcome === 'error' && charged === 0 ? 'failed' : 'settled',
      outcome: s.outcome,
      charged_mc: charged,
      input_tokens: s.usage.inputTokens,
      cached_tokens: s.usage.cachedTokens,
      output_tokens: s.usage.outputTokens,
      reasoning_tokens: s.usage.reasoningTokens,
      estimated: s.usage.estimated ? 1 : 0,
      cost_micro_usd: s.costMicroUsd,
      model_calls: Math.min(s.modelCalls, 30_000),
      tool_calls: Math.min(s.toolCalls, 30_000),
      error_code: s.errorCode?.slice(0, 60) ?? null,
      duration_ms: s.durationMs,
      conversation_id: s.conversationId ?? null,
      settled_at: now,
    })
    .where('id', '=', usageId)
    .execute();

  return { chargedMc: charged };
}

// ── Charges that are not questions ───────────────────────────────────────────

/**
 * Charge a fixed number of credits for something other than a question — a
 * report download. Recorded as a settled usage row, so it counts toward the
 * person's monthly limit and shows in the billing page's usage, and taken from
 * the soonest-expiring buckets like any charge. Refused, charging nothing,
 * when the wallet or the person's monthly limit cannot cover it.
 */
export async function spendCredits(
  trx: Trx,
  orgId: number,
  userId: number,
  mc: number,
  opts: { provider: string; model: string; note: string; monthlyCapMc: number | null; conversationId?: number | null },
  now = new Date(),
): Promise<{ usageId: number; chargedMc: number }> {
  if (!Number.isInteger(mc) || mc <= 0) throw new Error(`A charge must be a positive number of millicredits, not ${mc}.`);
  const held = await lockWallet(trx, orgId);
  const buckets = await liveBuckets(trx, orgId, now).forUpdate().execute();
  const available = buckets.reduce((t, b) => t + Number(b.remaining_mc), 0) - held;
  if (available < mc) throw new OutOfCreditsError(Math.max(0, available));
  if (opts.monthlyCapMc !== null) {
    const spent = await userSpendSince(trx, orgId, userId, istMonthStart(now));
    if (spent + mc > opts.monthlyCapMc) {
      throw new ApiError(
        429,
        `That would go past your monthly AI allowance of ${formatCredits(opts.monthlyCapMc)} credits. It resets on the 1st, or an admin can raise it.`,
        'user_cap_reached',
      );
    }
  }

  const row = await trx
    .insertInto('ai_usage')
    .values({
      org_id: orgId,
      user_id: userId,
      conversation_id: opts.conversationId ?? null,
      status: 'settled',
      provider: opts.provider.slice(0, 30),
      model: opts.model.slice(0, 80),
      hold_mc: mc,
      charged_mc: mc,
      settled_at: now,
    })
    .executeTakeFirstOrThrow();
  const usageId = Number(row.insertId);

  let left = mc;
  let balance = await ledgerBalance(trx, orgId);
  const lines: LedgerLine[] = [];
  for (const b of buckets) {
    if (left <= 0) break;
    const take = Math.min(Number(b.remaining_mc), left);
    if (take <= 0) continue;
    await trx
      .updateTable('ai_credit_buckets')
      .set((eb) => ({ remaining_mc: eb('remaining_mc', '-', take) }))
      .where('id', '=', b.id)
      .execute();
    balance -= take;
    left -= take;
    lines.push({ bucketId: b.id, kind: 'usage', deltaMc: -take, balanceAfterMc: balance, usageId, userId, note: opts.note });
  }
  await writeLedger(trx, orgId, lines);
  return { usageId, chargedMc: mc };
}

// ── Refunds and corrections ──────────────────────────────────────────────────

/**
 * Take back the credits a refunded payment bought — as many as are still
 * unspent. Credits already used cannot be un-used; the ledger shows exactly
 * how many were recovered.
 */
export async function clawBack(
  trx: Trx,
  orgId: number,
  paymentId: number,
  mc: number,
  note: string,
): Promise<number> {
  await lockWallet(trx, orgId);
  const bucket = await trx
    .selectFrom('ai_credit_buckets')
    .select(['id', 'remaining_mc'])
    .where('org_id', '=', orgId)
    .where('payment_id', '=', paymentId)
    .forUpdate()
    .executeTakeFirst();
  if (!bucket) return 0;

  const take = Math.min(Number(bucket.remaining_mc), Math.max(0, Math.round(mc)));
  if (take <= 0) return 0;
  const before = await ledgerBalance(trx, orgId);
  await trx
    .updateTable('ai_credit_buckets')
    .set((eb) => ({ remaining_mc: eb('remaining_mc', '-', take) }))
    .where('id', '=', bucket.id)
    .execute();
  await writeLedger(trx, orgId, [
    { bucketId: bucket.id, kind: 'refund', deltaMc: -take, balanceAfterMc: before - take, note },
  ]);
  return take;
}

/**
 * A manual correction by the platform operator — never exposed to an
 * organisation's own admins, who would otherwise be granting themselves
 * credit. Positive adds a non-expiring bucket; negative spends from the
 * soonest-expiring ones.
 */
export async function adjustCredits(
  trx: Trx,
  orgId: number,
  mc: number,
  note: string,
  now = new Date(),
): Promise<number> {
  if (mc > 0) {
    await grantCredits(trx, {
      orgId,
      source: 'adjustment',
      mc,
      expiresAt: null,
      grantKey: `adjust:${now.getTime()}:${Math.random().toString(36).slice(2, 8)}`,
      note,
    });
    return mc;
  }
  await lockWallet(trx, orgId);
  let left = -mc;
  const buckets = await liveBuckets(trx, orgId, now).forUpdate().execute();
  let balance = await ledgerBalance(trx, orgId);
  const lines: LedgerLine[] = [];
  for (const b of buckets) {
    if (left <= 0) break;
    const take = Math.min(Number(b.remaining_mc), left);
    await trx
      .updateTable('ai_credit_buckets')
      .set((eb) => ({ remaining_mc: eb('remaining_mc', '-', take) }))
      .where('id', '=', b.id)
      .execute();
    balance -= take;
    left -= take;
    lines.push({ bucketId: b.id, kind: 'adjustment', deltaMc: -take, balanceAfterMc: balance, note });
  }
  await writeLedger(trx, orgId, lines);
  return -(-mc - left);
}

// ── Reporting ────────────────────────────────────────────────────────────────

export interface UsageStats {
  days: { date: string; creditsMc: number; questions: number }[];
  byUser: { userId: number; name: string; creditsMc: number; questions: number }[];
  monthMc: number;
  monthQuestions: number;
}

/** Credits spent per Indian day and per person, for the billing page. */
export async function usageStats(ex: Executor, orgId: number, now = new Date(), days = 30): Promise<UsageStats> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const monthStart = istMonthStart(now);
  const rows = await ex
    .selectFrom('ai_usage')
    .leftJoin('users', 'users.id', 'ai_usage.user_id')
    .select(['ai_usage.user_id', 'ai_usage.charged_mc', 'ai_usage.created_at', 'ai_usage.status', 'ai_usage.provider', 'users.name'])
    .where('ai_usage.org_id', '=', orgId)
    .where('ai_usage.created_at', '>=', since < monthStart ? since : monthStart)
    .where('ai_usage.status', '=', 'settled')
    .execute();

  const byDay = new Map<string, { creditsMc: number; questions: number }>();
  for (let i = days - 1; i >= 0; i--) byDay.set(istDate(new Date(now.getTime() - i * 86_400_000)), { creditsMc: 0, questions: 0 });
  const byUser = new Map<number, { userId: number; name: string; creditsMc: number; questions: number }>();
  let monthMc = 0;
  let monthQuestions = 0;

  for (const r of rows) {
    const at = new Date(r.created_at);
    const mc = Number(r.charged_mc);
    // A report download spends credits, but it is not a question.
    const question = r.provider === 'download' ? 0 : 1;
    const day = byDay.get(istDate(at));
    if (day && at >= since) {
      day.creditsMc += mc;
      day.questions += question;
    }
    if (at >= monthStart) {
      monthMc += mc;
      monthQuestions += question;
      const u = byUser.get(r.user_id) ?? { userId: r.user_id, name: r.name ?? 'Former user', creditsMc: 0, questions: 0 };
      u.creditsMc += mc;
      u.questions += question;
      byUser.set(r.user_id, u);
    }
  }

  return {
    days: [...byDay.entries()].map(([date, v]) => ({ date, ...v })),
    byUser: [...byUser.values()].sort((a, b) => b.creditsMc - a.creditsMc),
    monthMc,
    monthQuestions,
  };
}
