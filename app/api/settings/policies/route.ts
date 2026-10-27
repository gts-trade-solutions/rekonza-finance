import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, badRequest } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { getPolicies, setPolicies } from '@/lib/server/services/org-settings';

// The book's own policies: which parts of the app it uses, and how firmly the
// credit-limit, stock and cash rules are applied. See org-settings.ts.

// Read by everyone signed in: the menus need the feature switches.
export const GET = route(async ({ orgId }) => getPolicies(db, orgId));

const Enforcement = z.enum(['off', 'warn', 'block']);
const Input = z.object({
  features: z.object({
    inventory: z.boolean(), fixedAssets: z.boolean(), tdsTcs: z.boolean(), ewayBills: z.boolean(),
    approvals: z.boolean(), tally: z.boolean(), analytics: z.boolean(), payroll: z.boolean(),
    gst: z.boolean(), multiCurrency: z.boolean(), costCentres: z.boolean(),
  }).partial().optional(),
  creditLimit: Enforcement.optional(),
  negativeStock: Enforcement.optional(),
  cashLimits: Enforcement.optional(),
  sessionIdleMinutes: z.number().int().min(0).max(1440).optional(),
  msmeBankRatePct: z.number().gt(0).lt(20).optional(),
  overdueInterestPct: z.number().min(0).max(60).optional(),
  overdueGraceDays: z.number().int().min(0).max(365).optional(),
  stockValuation: z.enum(['average', 'fifo']).optional(),
  requireMfa: z.enum(['off', 'admins', 'everyone']).optional(),
  recovery: z.object({ rpoHours: z.number().int().min(1).max(168).optional(), rtoMinutes: z.number().int().min(5).max(10_080).optional() }).optional(),
  reminders: z.object({
    enabled: z.boolean().optional(),
    stages: z.array(z.number().int().min(-30).max(180)).max(8).optional(),
    channel: z.enum(['whatsapp', 'email', 'sms']).optional(),
  }).optional(),
  signIn: z.object({
    allowedIps: z.array(z.string().max(50)).max(50).optional(),
    adminsAnywhere: z.boolean().optional(),
    maxSessions: z.number().int().min(0).max(20).optional(),
    alertNewDevice: z.boolean().optional(),
  }).optional(),
});

export const PUT = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    // Requiring it of others while not using it oneself would lock the admin
    // out of everything but the setup page on their next click.
    if (input.requireMfa && input.requireMfa !== 'off') {
      const me = await db.selectFrom('users').select('mfa_enabled_at').where('id', '=', user.userId).executeTakeFirstOrThrow();
      if (!me.mfa_enabled_at) throw badRequest('Turn on two-step sign-in for yourself first (Settings → Sign-ins).');
    }
    return transaction(async (trx) => {
      const before = await getPolicies(trx, orgId);
      const after = await setPolicies(trx, orgId, user.userId, input as never);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: 'organization', targetId: orgId, targetLabel: 'Policies',
        detail: `Policies changed: ${Object.keys(input).join(', ')}`, payload: { changes: { before, after } }, ...auditMeta(req),
      });
      return after;
    });
  },
  { permission: { module: 'settings', action: 'edit' } },
);
