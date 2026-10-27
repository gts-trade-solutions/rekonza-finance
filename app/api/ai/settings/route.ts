import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, badRequest, forbidden } from '@/lib/server/http';
import { auditMeta } from '@/lib/server/audit';
import { aiSettingsFor, setAiEnabled, setUserMonthlyCap } from '@/lib/server/ai/settings';

// ─────────────────────────────────────────────────────────────────────────────
// Turning the assistant on or off, and the per-person monthly limit.
//
// Turning it on the first time needs the admin to agree, explicitly, that
// questions and the figures needed to answer them go to the model provider.
// The agreement is recorded with their name and the time, in the settings and
// in the audit trail.
// ─────────────────────────────────────────────────────────────────────────────

const Input = z.object({
  enabled: z.boolean().optional(),
  acceptDataTerms: z.boolean().optional(),
  /** Credits per person per month. null removes the limit. */
  monthlyCapCredits: z.number().int().min(1).max(1_000_000).nullable().optional(),
});

export const PATCH = route(
  async ({ user, orgId, req }) => {
    const input = await body(req, Input);
    const current = await aiSettingsFor(db, orgId);
    if (current.isDemo) {
      throw forbidden('The demo book always has the assistant on, and its settings cannot be changed.');
    }
    if (input.enabled && !current.consentAt && !input.acceptDataTerms) {
      throw badRequest('Agree to how questions are processed before turning the assistant on.');
    }

    const actor = { userId: user.userId, name: user.name, ...auditMeta(req) };
    let trialGrantedMc = 0;
    await transaction(async (trx) => {
      if (input.enabled !== undefined && input.enabled !== current.enabled) {
        ({ trialGrantedMc } = await setAiEnabled(trx, orgId, input.enabled, actor));
      }
      if (input.monthlyCapCredits !== undefined) {
        await setUserMonthlyCap(trx, orgId, input.monthlyCapCredits, actor);
      }
    });

    const next = await aiSettingsFor(db, orgId);
    return {
      enabled: next.enabled,
      consentGiven: !!next.consentAt,
      userMonthlyCapMc: next.userMonthlyCapMc,
      trialGrantedMc,
    };
  },
  { permission: { module: 'billing', action: 'edit' } },
);
