import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { bankingPreferences, saveBankingPreferences } from '@/lib/server/services/banking-preferences';

// Zoho's Banking → More → Preferences (services/banking-preferences.ts).
export const GET = route(
  async ({ orgId }) => bankingPreferences(db, orgId),
  { permission: { module: 'banking', action: 'view' } },
);

const Prefs = z.object({
  applyRulesOnImport: z.boolean(),
  autoMatchOnImport: z.boolean(),
  matchWindowDays: z.number().int().min(0).max(30),
  defaultExpenseAccountId: z.union([z.string(), z.number()]).nullish().transform((v) => (v ? String(v) : null)),
  defaultIncomeAccountId: z.union([z.string(), z.number()]).nullish().transform((v) => (v ? String(v) : null)),
  showPaymentClearing: z.boolean(),
  keepDuplicates: z.boolean(),
  inboundEnabled: z.boolean(),
  inboundSenders: z.array(z.string().max(200)).max(50),
}).partial();

export const PUT = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Prefs);
    const before = await bankingPreferences(db, orgId);
    const saved = await transaction((trx) => saveBankingPreferences(trx, orgId, input));
    await logAudit({ orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'banking_preferences', targetId: orgId, detail: 'Banking preferences saved', payload: { before, after: saved }, ...auditMeta(req) });
    return saved;
  },
  { permission: { module: 'banking', action: 'edit' } },
);
