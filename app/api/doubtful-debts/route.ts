import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { adjustProvision, DEFAULT_PROVISION_RATES, provisionPlan } from '@/lib/server/services/journals';

// The provision for doubtful debts: what it should be at a date, from the
// receivables' ages and a rate for each, and the entry that brings it there.

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Rates = z.record(z.string(), z.number().min(0).max(100));

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ asOf: DATE.optional(), rates: z.string().optional() }));
    const rates = q.rates ? Rates.parse(JSON.parse(q.rates)) : DEFAULT_PROVISION_RATES;
    return provisionPlan(db, orgId, q.asOf ?? new Date().toISOString().slice(0, 10), rates);
  },
  { permission: { module: 'accountant', action: 'view' } },
);

export const POST = route(
  async ({ orgId, user, branchId, req }) => {
    const input = await body(req, z.object({ asOf: DATE, rates: Rates.optional() }));
    return transaction(async (trx) => {
      const r = await adjustProvision(trx, orgId, user.userId, branchId, input.asOf, input.rates ?? DEFAULT_PROVISION_RATES);
      if (r.entryId) {
        await logAudit({
          trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
          targetType: 'journal_entry', targetId: r.entryId, targetLabel: 'Doubtful debts',
          detail: `Provision for doubtful debts set to ₹${(r.plan.targetPaise / 100).toLocaleString('en-IN')} at ${input.asOf}`,
          payload: { rates: r.plan.rates }, ...auditMeta(req),
        });
      }
      return { entryId: r.entryId ? asId(r.entryId) : null, plan: r.plan };
    });
  },
  { permission: { module: 'accountant', action: 'create' } },
);
