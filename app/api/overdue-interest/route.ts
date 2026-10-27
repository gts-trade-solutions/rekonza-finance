import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, badRequest } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { getPolicies } from '@/lib/server/services/org-settings';
import { overdueInterest, raiseInterestInvoice } from '@/lib/server/services/overdue-interest';

// Interest on overdue invoices, at the book's own rate. See overdue-interest.ts.

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ asOf: date.optional() }));
    const asOf = q.asOf ?? localToday();
    const p = await getPolicies(db, orgId);
    return { asOf, ratePct: p.overdueInterestPct, graceDays: p.overdueGraceDays, rows: await overdueInterest(db, orgId, asOf, p.overdueInterestPct, p.overdueGraceDays) };
  },
  { permission: { module: 'sales', action: 'view' } },
);

export const POST = route(
  async ({ orgId, user, branchId, req }) => {
    const input = await body(req, z.object({ customerId: z.coerce.number().int().positive(), asOf: date }));
    return transaction(async (trx) => {
      const p = await getPolicies(trx, orgId);
      if (!p.overdueInterestPct) throw badRequest('Set an interest rate in Settings → Policies first.');
      const branch = branchId || (await trx.selectFrom('branches').select('id').where('org_id', '=', orgId).orderBy('is_primary', 'desc').executeTakeFirstOrThrow()).id;
      const inv = await raiseInterestInvoice(trx, orgId, user.userId, {
        customerId: input.customerId, asOf: input.asOf, ratePct: p.overdueInterestPct, graceDays: p.overdueGraceDays, branchId: branch,
      });
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'invoice', targetId: inv.id,
        targetLabel: inv.number, detail: `Interest on overdue invoices to ${input.asOf}, raised as a draft`, ...auditMeta(req),
      });
      return { id: String(inv.id), number: inv.number, totalPaise: inv.totalPaise };
    });
  },
  { permission: { module: 'sales', action: 'create' } },
);
