import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Whether an organisation has turned the assistant on, and on what terms.
//
// Off by default. Asking a question sends it — and the figures needed to
// answer it — to the model provider, and that is the organisation's decision
// to make, not the software's. The admin who makes it is recorded with the
// time, and the first time it is made the organisation receives its trial.
//
// The shared demo book is always on: it exists to be tried, and it holds no
// real business's data to protect.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import { logAudit } from '../audit';
import { MC_PER_CREDIT, TRIAL_DAYS } from '../../billing/catalog';
import { grantCredits } from '../billing/wallet';
import { trialCredits } from './config';

export interface AiOrgSettings {
  orgName: string;
  isDemo: boolean;
  enabled: boolean;
  consentAt: Date | null;
  consentByUserId: number | null;
  userMonthlyCapMc: number | null;
  trialGrantedAt: Date | null;
}

export async function aiSettingsFor(ex: Executor, orgId: number): Promise<AiOrgSettings> {
  const row = await ex
    .selectFrom('organizations as o')
    .leftJoin('ai_settings as s', 's.org_id', 'o.id')
    .select([
      'o.name', 'o.is_demo', 's.enabled', 's.consent_at', 's.consent_by_user_id',
      's.user_monthly_cap_mc', 's.trial_granted_at',
    ])
    .where('o.id', '=', orgId)
    .executeTakeFirstOrThrow();

  const isDemo = !!row.is_demo;
  return {
    orgName: row.name,
    isDemo,
    enabled: isDemo || !!row.enabled,
    consentAt: row.consent_at ? new Date(row.consent_at) : null,
    consentByUserId: row.consent_by_user_id ?? null,
    userMonthlyCapMc: row.user_monthly_cap_mc === null || row.user_monthly_cap_mc === undefined ? null : Number(row.user_monthly_cap_mc),
    trialGrantedAt: row.trial_granted_at ? new Date(row.trial_granted_at) : null,
  };
}

interface Actor {
  userId: number;
  name: string;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Turn the assistant on or off. Turning it on for the first time records the
 * consent and grants the trial, in the same transaction — an organisation that
 * has agreed always has the credits to try it, and one that has not never has.
 */
export async function setAiEnabled(
  trx: Trx,
  orgId: number,
  enabled: boolean,
  actor: Actor,
  now = new Date(),
): Promise<{ trialGrantedMc: number }> {
  const current = await aiSettingsFor(trx, orgId);

  await trx
    .insertInto('ai_settings')
    .values({
      org_id: orgId,
      enabled: enabled ? 1 : 0,
      consent_at: enabled ? now : null,
      consent_by_user_id: enabled ? actor.userId : null,
      updated_by_user_id: actor.userId,
    })
    .onDuplicateKeyUpdate({
      enabled: enabled ? 1 : 0,
      // Consent is recorded when given and kept: switching off later does not
      // erase the fact that it was once agreed, and by whom.
      ...(enabled && !current.consentAt ? { consent_at: now, consent_by_user_id: actor.userId } : {}),
      updated_by_user_id: actor.userId,
    })
    .execute();

  let trialGrantedMc = 0;
  if (enabled && !current.trialGrantedAt && !current.isDemo) {
    const mc = Math.round(trialCredits() * MC_PER_CREDIT);
    const { created } = await grantCredits(trx, {
      orgId,
      source: 'trial',
      mc,
      expiresAt: new Date(now.getTime() + TRIAL_DAYS * 86_400_000),
      grantKey: 'trial',
      note: `Free trial — ${trialCredits()} credits for ${TRIAL_DAYS} days`,
      userId: actor.userId,
    });
    if (created) trialGrantedMc = mc;
    await trx.updateTable('ai_settings').set({ trial_granted_at: now }).where('org_id', '=', orgId).execute();
  }

  await logAudit({
    trx,
    orgId,
    actorUserId: actor.userId,
    actorName: actor.name,
    action: 'update',
    targetType: 'ai_settings',
    targetId: orgId,
    detail: enabled
      ? `Turned the AI assistant on${current.consentAt ? '' : ' and agreed to send questions and the figures needed to answer them to the model provider'}`
      : 'Turned the AI assistant off',
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
  });

  return { trialGrantedMc };
}

/** Set, change or remove the most one person may spend in a month. */
export async function setUserMonthlyCap(
  trx: Trx,
  orgId: number,
  capCredits: number | null,
  actor: Actor,
): Promise<void> {
  const capMc = capCredits === null ? null : Math.round(capCredits * MC_PER_CREDIT);
  await trx
    .insertInto('ai_settings')
    .values({ org_id: orgId, enabled: 0, user_monthly_cap_mc: capMc, updated_by_user_id: actor.userId })
    .onDuplicateKeyUpdate({ user_monthly_cap_mc: capMc, updated_by_user_id: actor.userId })
    .execute();

  await logAudit({
    trx,
    orgId,
    actorUserId: actor.userId,
    actorName: actor.name,
    action: 'update',
    targetType: 'ai_settings',
    targetId: orgId,
    detail: capCredits === null ? 'Removed the per-person monthly AI limit' : `Set the per-person monthly AI limit to ${capCredits} credits`,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
  });
}
