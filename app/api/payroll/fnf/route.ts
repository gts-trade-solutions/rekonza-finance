import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, asId, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { fnfStatement, listFnf, payFnf, postFnf } from '@/lib/server/payroll/fnf';

// Full and final settlements: work one out, post it, pay it.

export const GET = route(async ({ orgId }) => ({ settlements: await listFnf(db, orgId) }), { permission: { module: 'payroll', action: 'view' } });

const Id = z.union([z.string(), z.number()]).transform(Number);
const Statement = z.object({
  employeeId: Id, lastDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), waiveFiveYears: z.boolean().optional(),
  encashDays: z.number().min(0).nullish(), encashDivisor: z.union([z.literal(26), z.literal(30)]).optional(),
  noticePayDays: z.number().min(0).max(365).optional(), noticeShortDays: z.number().min(0).max(365).optional(),
  otherEarningsPaise: z.number().int().min(0).optional(), otherRecoveriesPaise: z.number().int().min(0).optional(),
  tdsPaise: z.number().int().min(0).optional(), note: z.string().max(500).nullish(),
});
const Input = z.discriminatedUnion('action', [
  Statement.extend({ action: z.literal('preview') }),
  Statement.extend({ action: z.literal('post') }),
  z.object({ action: z.literal('pay'), id: Id, bankAccountId: Id, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
]);

export const POST = route(
  async ({ orgId, user, role, req }) => {
    const input = await body(req, Input);
    if (input.action === 'preview') return fnfStatement(db, orgId, input);
    if (!hasPermission(role, 'payroll', 'approve')) throw forbidden('Posting or paying a settlement needs payroll approval rights.');
    return transaction(async (trx) => {
      if (input.action === 'post') {
        const r = await postFnf(trx, orgId, user.userId, input);
        await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'fnf', targetId: r.id, detail: `Full and final settlement posted, net ${(r.netPaise / 100).toFixed(2)}`, ...auditMeta(req) });
        return { id: asId(r.id) };
      }
      const entryId = await payFnf(trx, orgId, user.userId, input.id, input);
      await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'fnf', targetId: input.id, detail: `Settlement paid on ${input.date}`, ...auditMeta(req) });
      return { id: asId(input.id), entryId: asId(entryId) };
    });
  },
  { permission: { module: 'payroll', action: 'view' } },
);
