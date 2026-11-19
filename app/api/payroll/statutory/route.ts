import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { COMPONENT_LABEL, payStatutory, statutoryRegister } from '@/lib/server/payroll/statutory-dues';

// The payroll statutory registers (PF, ESI, PT, LWF, TDS on salary) and each
// month's dues against what has been paid; paying a due posts it to the ledger.
// See lib/server/payroll/statutory-dues.ts.

const Month = z.string().regex(/^\d{4}-\d{2}$/);

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ from: Month, to: Month }));
    return statutoryRegister(db, orgId, q.from, q.to);
  },
  { permission: { module: 'payroll', action: 'view' } },
);

const PayInput = z.object({
  component: z.enum(['pf', 'esi', 'pt', 'lwf']),
  period: Month,
  amountPaise: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  bankAccountId: z.union([z.string(), z.number()]).transform(Number),
  reference: z.string().trim().max(60).nullish(),
});

export const POST = route(
  async ({ orgId, user, role, req }) => {
    if (!hasPermission(role, 'payroll', 'approve') || !hasPermission(role, 'banking', 'create')) {
      throw forbidden('Paying statutory dues needs payroll approval and banking rights.');
    }
    const input = await body(req, PayInput);
    const done = await transaction(async (trx) => {
      const r = await payStatutory(trx, orgId, user.userId, input);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'statutory_payment', targetId: r.id,
        targetLabel: `${COMPONENT_LABEL[input.component]} ${input.period}`,
        detail: `Paid ₹${(input.amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} of ${COMPONENT_LABEL[input.component]} for ${input.period}${input.reference ? ` (${input.reference})` : ''}`,
        ...auditMeta(req),
      });
      return r;
    });
    return { id: String(done.id), entryId: String(done.entryId) };
  },
  { permission: { module: 'payroll', action: 'view' } },
);
