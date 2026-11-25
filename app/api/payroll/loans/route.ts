import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, forbidden } from '@/lib/server/http';
import { changeReason } from '@/lib/server/request-context';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { cancelLoan, giveLoan, listLoans } from '@/lib/server/payroll/loans';
import { deleteLoan, updateLoan } from '@/lib/server/payroll/changes';

// Salary advances and loans to employees, recovered through payroll.

export const GET = route(async ({ orgId }) => ({ loans: await listLoans(db, orgId) }), { permission: { module: 'payroll', action: 'view' } });

const Id = z.union([z.string(), z.number()]).transform(Number);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const LoanInput = z.object({
  employeeId: Id, kind: z.enum(['advance', 'loan']), amountPaise: z.number().int().positive(), instalmentPaise: z.number().int().positive(),
  givenOn: DATE, firstMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), bankAccountId: Id, notes: z.string().max(300).nullish(),
});

export const POST = route(
  async ({ orgId, user, role, req }) => {
    // Giving one moves money out of the bank: approval rights, as paying salaries does.
    if (!hasPermission(role, 'payroll', 'approve')) throw forbidden('Giving an advance needs approval rights in payroll.');
    const input = await body(req, LoanInput);
    return transaction(async (trx) => {
      const id = await giveLoan(trx, orgId, user.userId, input);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'employee_loan', targetId: id,
        targetLabel: `${input.kind === 'loan' ? 'Loan' : 'Advance'} of ₹${(input.amountPaise / 100).toFixed(2)}`,
        detail: `Gave a ${input.kind}, recovered at ₹${(input.instalmentPaise / 100).toFixed(2)} a month from ${input.firstMonth}`, ...auditMeta(req),
      });
      return { id: asId(id) };
    });
  },
  { permission: { module: 'payroll', action: 'create' } },
);

export const PATCH = route(
  async ({ orgId, user, role, req }) => {
    if (!hasPermission(role, 'payroll', 'approve')) throw forbidden('Cancelling an advance needs approval rights in payroll.');
    const input = await body(req, z.object({ id: Id, reason: z.string().max(300) }));
    return transaction(async (trx) => {
      await cancelLoan(trx, orgId, user.userId, input.id, input.reason);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'void', targetType: 'employee_loan', targetId: input.id,
        targetLabel: 'Advance', detail: `Cancelled: ${input.reason}`, ...auditMeta(req),
      });
      return { id: asId(input.id) };
    });
  },
  { permission: { module: 'payroll', action: 'edit' } },
);

/**
 * Change an advance (payroll/changes.ts). Its terms change on the record; a
 * change to the money reverses the payment out and posts it again, so it takes
 * approval rights, as giving one does.
 */
export const PUT = route(
  async ({ orgId, user, role, req }) => {
    if (!hasPermission(role, 'payroll', 'approve')) throw forbidden('Changing an advance needs approval rights in payroll.');
    const input = await body(req, LoanInput.extend({ id: Id }));
    return transaction(async (trx) => {
      const r = await updateLoan(trx, orgId, user.userId, input.id, input);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'employee_loan', targetId: input.id,
        targetLabel: `${input.kind === 'loan' ? 'Loan' : 'Advance'} to ${r.name}`,
        detail: `Changed to ₹${(input.amountPaise / 100).toFixed(2)}, recovered at ₹${(input.instalmentPaise / 100).toFixed(2)} a month from ${input.firstMonth}`
          + (r.reposted ? '; its entry reversed and posted again' : ''),
        ...auditMeta(req),
      });
      return { id: asId(input.id) };
    });
  },
  { permission: { module: 'payroll', action: 'edit' } },
);

/** Delete an advance given in error: its entry reversed, the record kept (payroll/changes.ts). */
export const DELETE = route(
  async ({ orgId, user, req }) => {
    const { id } = query(req, z.object({ id: Id }));
    const reason = changeReason();
    return transaction(async (trx) => {
      const r = await deleteLoan(trx, orgId, user.userId, id, reason);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'void', targetType: 'employee_loan', targetId: id,
        targetLabel: `${r.kind === 'loan' ? 'Loan' : 'Advance'} to ${r.name}`, detail: `Deleted; its entry reversed${reason ? `: ${reason}` : ''}`, ...auditMeta(req),
      });
      return { id: asId(id), deleted: true };
    });
  },
  { permission: { module: 'payroll', action: 'void' } },
);
