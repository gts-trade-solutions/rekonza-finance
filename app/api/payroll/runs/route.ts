import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { listRuns, prepareRun, salaryTdsQuarter } from '@/lib/server/payroll/payroll';

// Monthly payroll runs, and the quarter's salary TDS for Form 24Q (Form 138).

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({
      view: z.enum(['runs', 'tds']).default('runs'),
      fy: z.coerce.number().int().optional(),
      quarter: z.coerce.number().int().min(1).max(4).optional(),
    }));
    if (q.view === 'tds') return salaryTdsQuarter(db, orgId, q.fy ?? new Date().getFullYear(), (q.quarter ?? 1) as 1 | 2 | 3 | 4);
    return { runs: await listRuns(db, orgId) };
  },
  { permission: { module: 'payroll', action: 'view' } },
);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }));
    return transaction(async (trx) => {
      const id = await prepareRun(trx, orgId, user.userId, input.month);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
        targetType: 'payroll', targetId: id, targetLabel: `Payroll ${input.month}`, detail: `Payroll for ${input.month} prepared`,
        ...auditMeta(req),
      });
      return { id: String(id) };
    });
  },
  { permission: { module: 'payroll', action: 'create' } },
);
