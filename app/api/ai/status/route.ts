import { db, transaction } from '@/lib/server/db';
import { route } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { planByCode } from '@/lib/billing/catalog';
import { prepareWallet, userSpendSince, walletView } from '@/lib/server/billing/wallet';
import { activeModel, aiMode, questionCapMc } from '@/lib/server/ai/config';
import { detectFlags, suggestedPrompts } from '@/lib/server/ai/insights';
import { aiSettingsFor } from '@/lib/server/ai/settings';
import { hiddenAreas } from '@/lib/server/ai/tools';
import { istMonthStart } from '@/lib/server/ai/time';

// ─────────────────────────────────────────────────────────────────────────────
// Everything the assistant's page needs before the first question: whether it
// is on, what is left to spend, what to suggest asking, and what the rules
// have found that needs attention.
//
// Reading it also brings the wallet up to date — this month's plan credits
// are granted, and expired ones cleared — so the balance on screen is the
// balance a question would actually draw on.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(
  async ({ user, orgId, role }) => {
    const settings = await aiSettingsFor(db, orgId);
    if (settings.enabled) {
      // The top bar reads the balance at the same moment, preparing the same
      // wallet: a deadlock between the two is retried, not shown.
      await transaction((trx) => prepareWallet(trx, orgId, new Date(), { isDemo: settings.isDemo }), {
        retryDeadlocks: true,
      });
    }

    const [wallet, sub, flags, spent] = await Promise.all([
      walletView(db, orgId),
      db
        .selectFrom('billing_subscriptions')
        .select(['plan_code', 'status', 'current_end', 'cancel_at_period_end'])
        .where('org_id', '=', orgId)
        .where('status', 'in', ['active', 'pending', 'halted', 'authenticated'])
        .orderBy('id', 'desc')
        .executeTakeFirst(),
      detectFlags(db, orgId, role),
      settings.userMonthlyCapMc !== null ? userSpendSince(db, orgId, user.userId, istMonthStart()) : Promise.resolve(null),
    ]);

    const trial = wallet.buckets.find((b) => b.source === 'trial');
    const expiring = wallet.buckets.find((b) => b.expiresAt);
    const plan = sub ? planByCode(sub.plan_code) : undefined;

    return {
      enabled: settings.enabled,
      consentGiven: !!settings.consentAt,
      isDemo: settings.isDemo,
      canManage: hasPermission(role, 'billing', 'edit') && !settings.isDemo,
      mode: aiMode(),
      model: activeModel(),
      wallet: {
        availableMc: wallet.availableMc,
        totalMc: wallet.totalMc,
        heldMc: wallet.heldMc,
        trialExpiresAt: trial?.expiresAt ?? null,
        nextExpiry: expiring ? { mc: expiring.remainingMc, at: expiring.expiresAt } : null,
      },
      plan: sub
        ? {
            code: sub.plan_code,
            name: plan?.name ?? sub.plan_code,
            status: sub.status,
            renewsAt: sub.current_end ? new Date(sub.current_end).toISOString() : null,
            cancelAtPeriodEnd: !!sub.cancel_at_period_end,
          }
        : null,
      userCap: settings.userMonthlyCapMc !== null ? { capMc: settings.userMonthlyCapMc, spentMc: spent ?? 0 } : null,
      questionCapMc: questionCapMc(),
      suggestions: suggestedPrompts(role),
      hidden: hiddenAreas(role),
      flags,
    };
  },
  { permission: { module: 'ai', action: 'view' } },
);
