import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, idParam, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { employedDays, payRun, postRun, prepareRun, reopenRun, runDetail } from '@/lib/server/payroll/payroll';

// One month's payroll: its lines, and what can be done to it.

export const GET = route(
  async ({ orgId, params }) => runDetail(db, orgId, idParam(params)),
  { permission: { module: 'payroll', action: 'view' } },
);

const paise = z.number().int().min(0);
const Input = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('recompute'),
    inputs: z.record(z.string(), z.object({
      lopDays: z.number().min(0).max(31).optional(),
      bonusPaise: paise.optional(),
      reimbursementPaise: paise.optional(),
      advanceRecoveryPaise: paise.optional(),
      notes: z.string().max(300).nullish(),
    })).default({}),
  }),
  // An attendance sheet: each employee's unpaid days, or the days they were
  // present, from which the unpaid days are what is left of their month.
  z.object({
    action: z.literal('attendance'),
    rows: z.array(z.object({
      code: z.string().trim().min(1).max(30),
      lopDays: z.number().min(0).max(31).nullish(),
      presentDays: z.number().min(0).max(31).nullish(),
    })).min(1).max(5000),
  }),
  z.object({ action: z.literal('post') }),
  z.object({ action: z.literal('pay'), bankAccountId: z.coerce.number().int().positive(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.object({ action: z.literal('reopen'), reason: z.string().max(300) }),
]);

const DETAIL = { recompute: 'Payroll recomputed', attendance: 'Attendance imported', post: 'Payroll posted', pay: 'Salaries paid', reopen: 'Payroll reopened' } as const;

export const POST = route(
  async ({ orgId, user, role, req, params }) => {
    const id = idParam(params);
    const input = await body(req, Input);
    // Posting, paying or undoing salaries moves money: it takes approval rights, not just edit.
    if (input.action !== 'recompute' && input.action !== 'attendance' && !hasPermission(role, 'payroll', 'approve')) {
      throw forbidden('Posting, paying or reopening a payroll needs approval rights in payroll.');
    }
    return transaction(async (trx) => {
      const run = await runDetail(trx, orgId, id);
      let unmatched: string[] = [];
      if (input.action === 'recompute') {
        const inputs = Object.fromEntries(Object.entries(input.inputs).map(([k, v]) => [Number(k), v]));
        await prepareRun(trx, orgId, user.userId, run.month, inputs);
      } else if (input.action === 'attendance') {
        const people = await trx.selectFrom('employees').select(['id', 'code', 'date_of_joining', 'date_of_leaving']).where('org_id', '=', orgId).execute();
        const byCode = new Map(people.map((e) => [e.code.toUpperCase(), e]));
        const inputs: Record<number, { lopDays: number }> = {};
        for (const r of input.rows) {
          const e = byCode.get(r.code.toUpperCase());
          if (!e || (r.lopDays == null && r.presentDays == null)) { unmatched.push(r.code); continue; }
          const { employed } = employedDays(e, run.month);
          inputs[e.id] = { lopDays: r.lopDays ?? Math.max(0, employed - (r.presentDays ?? employed)) };
        }
        unmatched = [...new Set(unmatched)];
        await prepareRun(trx, orgId, user.userId, run.month, inputs);
      } else if (input.action === 'post') {
        await postRun(trx, orgId, user.userId, id);
      } else if (input.action === 'pay') {
        await payRun(trx, orgId, user.userId, id, { bankAccountId: input.bankAccountId, date: input.date });
      } else {
        await reopenRun(trx, orgId, user.userId, id, input.reason);
      }
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: input.action === 'post' ? 'approve' : 'update',
        targetType: 'payroll', targetId: id, targetLabel: `Payroll ${run.month}`,
        detail: input.action === 'pay' ? `${DETAIL.pay} on ${input.date}` : input.action === 'reopen' ? `${DETAIL.reopen}: ${input.reason}`
          : input.action === 'attendance' ? `${DETAIL.attendance}: ${input.rows.length - unmatched.length} employee(s)` : DETAIL[input.action],
        ...auditMeta(req),
      });
      return { ...(await runDetail(trx, orgId, id)), unmatched };
    });
  },
  { permission: { module: 'payroll', action: 'edit' } },
);
