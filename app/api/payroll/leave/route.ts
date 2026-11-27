import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, badRequest } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import {
  grantLeave, leaveBalances, leaveRegister, listLeaveTypes, recordLeave, saveLeaveType,
} from '@/lib/server/payroll/leave';
import { deleteLeaveEntry, deleteLeaveType, updateLeaveEntry } from '@/lib/server/payroll/changes';
import { indiaToday } from '@/lib/server/services/held-journals';

// Leave: its kinds, each employee's balances, and the register of leave taken.

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }));
    const asOf = q.asOf ?? indiaToday();
    const types = await transaction((trx) => listLeaveTypes(trx, orgId));
    const [employees, balances, register] = await Promise.all([
      db.selectFrom('employees').select(['id', 'code', 'name', 'date_of_leaving']).where('org_id', '=', orgId)
        .where((eb) => eb.or([eb('date_of_leaving', 'is', null), eb('date_of_leaving', '>=', asOf)])).orderBy('code').execute(),
      leaveBalances(db, orgId, asOf),
      leaveRegister(db, orgId),
    ]);
    return {
      asOf, types, register,
      employees: employees.map((e) => ({
        id: asId(e.id), code: e.code, name: e.name,
        balances: Object.fromEntries(types.map((t) => [t.id, balances.get(e.id)?.get(Number(t.id)) ?? 0])),
      })),
    };
  },
  { permission: { module: 'payroll', action: 'view' } },
);

const Id = z.union([z.string(), z.number()]).transform(Number);
const Date_ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Input = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save-type'), id: Id.nullish(), code: z.string().max(10), name: z.string().trim().min(1).max(60), paid: z.boolean(),
    annualDays: z.number().min(0).max(366), accrual: z.enum(['monthly', 'yearly']), carryForwardMax: z.number().min(0).max(366).nullable(),
    encashable: z.boolean(), isActive: z.boolean().optional(),
  }),
  z.object({ action: z.literal('record'), employeeId: Id, leaveTypeId: Id, from: Date_, to: Date_, days: z.number().positive().nullish(), note: z.string().max(300).nullish() }),
  z.object({ action: z.literal('grant'), employeeId: Id, leaveTypeId: Id, kind: z.enum(['opening', 'adjustment']), days: z.number(), date: Date_, note: z.string().max(300).nullish() }),
  z.object({ action: z.literal('cancel'), id: Id }),
  // Correct leave recorded by hand (payroll/changes.ts): taken leave's kind,
  // dates and days, or an opening balance or adjustment's days and date.
  z.object({
    action: z.literal('update'), id: Id, leaveTypeId: Id.optional(), from: Date_.optional(), to: Date_.optional(),
    days: z.number().nullish(), date: Date_.optional(), note: z.string().max(300).nullish(),
  }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    return transaction(async (trx) => {
      const audit = (targetType: string, targetId: number, detail: string) => logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType, targetId, detail, ...auditMeta(req),
      });
      switch (input.action) {
        case 'save-type': {
          const id = await saveLeaveType(trx, orgId, { ...input, id: input.id ?? null });
          await audit('leave_type', id, `${input.code} ${input.name}: ${input.annualDays} days a year, ${input.accrual}`);
          return { id: asId(id) };
        }
        case 'record': {
          const id = await recordLeave(trx, orgId, user.userId, input);
          await audit('leave', id, `Leave from ${input.from} to ${input.to}`);
          return { id: asId(id) };
        }
        case 'grant': {
          const id = await grantLeave(trx, orgId, user.userId, input);
          await audit('leave', id, `${input.kind === 'opening' ? 'Opening balance' : 'Adjustment'} of ${input.days} day(s)`);
          return { id: asId(id) };
        }
        case 'cancel': {
          // Through the same checks as Delete: unpaid leave in a posted month stays.
          await deleteLeaveEntry(trx, orgId, input.id);
          await audit('leave', input.id, 'Leave cancelled');
          return { id: asId(input.id) };
        }
        case 'update': {
          const r = await updateLeaveEntry(trx, orgId, input.id, input);
          await audit('leave', input.id, `Leave of ${r.name} changed`);
          return { id: asId(input.id) };
        }
      }
    });
  },
  { permission: { module: 'payroll', action: 'edit' } },
);

/**
 * Delete leave recorded by hand (it is kept, marked cancelled), or a kind of
 * leave nobody has used (payroll/changes.ts).
 */
export const DELETE = route(
  async ({ orgId, user, req }) => {
    const q = query(req, z.object({ entryId: Id.optional(), typeId: Id.optional() }));
    if (!q.entryId === !q.typeId) throw badRequest('Say which leave, or which kind of leave, to delete.');
    return transaction(async (trx) => {
      if (q.typeId) {
        const t = await deleteLeaveType(trx, orgId, q.typeId);
        await logAudit({
          trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'void', targetType: 'leave_type', targetId: q.typeId,
          targetLabel: t.name, detail: `Kind of leave ${t.code} ${t.name} deleted`, ...auditMeta(req),
        });
        return { id: asId(q.typeId), deleted: true };
      }
      const e = await deleteLeaveEntry(trx, orgId, q.entryId!);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'void', targetType: 'leave', targetId: q.entryId!,
        targetLabel: e.name, detail: `${e.kind === 'taken' ? 'Leave' : e.kind === 'opening' ? 'Opening balance' : 'Adjustment'} of ${e.name} deleted`,
        ...auditMeta(req),
      });
      return { id: asId(q.entryId!), deleted: true };
    });
  },
  { permission: { module: 'payroll', action: 'void' } },
);
