import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, idParam, query, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { changeReason } from '@/lib/server/request-context';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { paySalaries, reverseSalaryPayment, salaryBankFile, salaryPayments } from '@/lib/server/payroll/salary-payments';
import { monthLabel } from '@/lib/date-range';

// One month's salary payments, employee by employee: who is paid and who is
// not, paying some or all, the bank's bulk-transfer file, and taking one
// payment back. See lib/server/payroll/salary-payments.ts.

export const GET = route(
  async ({ orgId, params, req }) => {
    const runId = idParam(params);
    const q = query(req, z.object({
      view: z.enum(['list', 'bank-file']).default('list'),
      bankAccountId: z.coerce.number().int().positive().optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }));
    if (q.view === 'bank-file') return salaryBankFile(db, orgId, runId, { bankAccountId: q.bankAccountId ?? null, date: q.date ?? new Date().toISOString().slice(0, 10) });
    return salaryPayments(db, orgId, runId);
  },
  { permission: { module: 'payroll', action: 'view' } },
);

const Input = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('pay'), bankAccountId: z.coerce.number().int().positive(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    employeeIds: z.array(z.union([z.string(), z.number()]).transform(Number)).nullish(), reference: z.string().trim().max(60).nullish(),
  }),
  z.object({ action: z.literal('reverse'), paymentId: z.union([z.string(), z.number()]).transform(Number), reason: z.string().trim().max(300).nullish() }),
]);

export const POST = route(
  async ({ orgId, user, role, req, params }) => {
    const runId = idParam(params);
    // Paying salaries moves money: payroll approval and banking rights.
    if (!hasPermission(role, 'payroll', 'approve') || !hasPermission(role, 'banking', 'create')) {
      throw forbidden('Paying salaries needs payroll approval and banking rights.');
    }
    const input = await body(req, Input);
    return transaction(async (trx) => {
      if (input.action === 'pay') {
        const r = await paySalaries(trx, orgId, user.userId, runId, { bankAccountId: input.bankAccountId, date: input.date, employeeIds: input.employeeIds ?? null, reference: input.reference });
        await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'payroll', targetId: runId,
          targetLabel: `Payroll ${runId}`, detail: `Salaries paid on ${input.date} to ${r.employees} employee(s): ₹${(r.paidPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}${r.fullyPaid ? '; everyone is paid' : ''}`, ...auditMeta(req) });
        return { entryId: String(r.entryId), paidPaise: r.paidPaise, employees: r.employees, fullyPaid: r.fullyPaid };
      }
      const reason = input.reason ?? changeReason();
      const r = await reverseSalaryPayment(trx, orgId, user.userId, input.paymentId, reason);
      await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'void', targetType: 'payroll', targetId: r.runId,
        targetLabel: `Payroll ${r.month}`, detail: `Salary payment of ₹${(r.amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} to ${r.name} for ${monthLabel(r.month)} taken back${reason ? `: ${reason}` : ''}`, ...auditMeta(req) });
      return { ok: true, reversalEntryId: String(r.reversalEntryId) };
    });
  },
  { permission: { module: 'payroll', action: 'edit' } },
);
