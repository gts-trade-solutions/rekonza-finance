import { db, transaction } from '@/lib/server/db';
import { route } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { planByCode } from '@/lib/billing/catalog';
import { prepareWallet, walletView } from '@/lib/server/billing/wallet';
import { aiMode } from '@/lib/server/ai/config';
import { aiSettingsFor } from '@/lib/server/ai/settings';

// ─────────────────────────────────────────────────────────────────────────────
// The balance, and little else, for the top bar and the corner assistant.
//
// Read once when the app loads and again after anything that moves it. The
// assistant's own page reads /api/ai/status, which also runs the checks over
// the books; this does none of that, so it is cheap enough for every screen.
// Like the status, it brings the wallet up to date first, so a new month's
// plan credits or the demo book's daily allowance show without a visit to
// the assistant.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(
  async ({ orgId, role }) => {
    const settings = await aiSettingsFor(db, orgId);
    if (settings.enabled) {
      // Read alongside the status and the billing page, which prepare the same
      // wallet: a deadlock between them is retried, not shown.
      await transaction((trx) => prepareWallet(trx, orgId, new Date(), { isDemo: settings.isDemo }), {
        retryDeadlocks: true,
      });
    }

    const [wallet, sub] = await Promise.all([
      walletView(db, orgId),
      db
        .selectFrom('billing_subscriptions')
        .select(['plan_code', 'status'])
        .where('org_id', '=', orgId)
        .where('status', 'in', ['active', 'pending', 'halted', 'authenticated'])
        .orderBy('id', 'desc')
        .executeTakeFirst(),
    ]);
    const trial = wallet.buckets.find((b) => b.source === 'trial');

    return {
      enabled: settings.enabled,
      mode: aiMode(),
      isDemo: settings.isDemo,
      canManage: hasPermission(role, 'billing', 'edit') && !settings.isDemo,
      availableMc: wallet.availableMc,
      trialExpiresAt: trial?.expiresAt ?? null,
      plan: sub ? { name: planByCode(sub.plan_code)?.name ?? sub.plan_code, status: sub.status } : null,
    };
  },
  { permission: { module: 'ai', action: 'view' } },
);
