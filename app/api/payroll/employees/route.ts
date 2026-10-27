import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { createEmployee, listEmployees, setSalary, updateEmployee, type EmployeeInput } from '@/lib/server/payroll/employees';

// Employees and their salary structure. Salaries are confidential, so every
// call needs payroll rights, which only admins and accountants have.

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const paise = z.number().int().min(0);
const Employee = z.object({
  branchId: z.coerce.number().int().positive(),
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(150),
  gender: z.enum(['male', 'female', 'other']).nullish(),
  dateOfBirth: date.nullish().or(z.literal('')),
  dateOfJoining: date,
  dateOfLeaving: date.nullish().or(z.literal('')),
  designation: z.string().trim().max(100).nullish(),
  department: z.string().trim().max(100).nullish(),
  email: z.string().trim().email().max(150).nullish().or(z.literal('')),
  mobile: z.string().trim().max(15).nullish(),
  pan: z.string().trim().max(10).nullish(),
  aadhaarNo: z.string().transform((v) => v.replace(/\s/g, '')).pipe(z.string().regex(/^\d{12}$/, 'An Aadhaar number is twelve digits.')).nullish(),
  uan: z.string().trim().max(12).nullish(),
  esiIpNumber: z.string().trim().max(17).nullish(),
  pfMember: z.boolean().optional(),
  epsMember: z.boolean().optional(),
  pfOnActual: z.boolean().optional(),
  ptApplicable: z.boolean().optional(),
  lwfApplicable: z.boolean().optional(),
  disabled: z.boolean().optional(),
  taxRegime: z.enum(['new', 'old']).optional(),
  declaredDeductionsPaise: paise.optional(),
  metroCity: z.boolean().optional(),
  bankAccountName: z.string().trim().max(150).nullish(),
  bankAccountNo: z.string().trim().max(34).nullish(),
  bankIfsc: z.string().trim().max(11).nullish(),
});
const Structure = z.object({ basic: paise, da: paise, hra: paise, special: paise, other: paise });

/** Empty strings from a form are absent values. */
const clean = (e: z.infer<typeof Employee>): EmployeeInput => ({
  ...e, dateOfBirth: e.dateOfBirth || null, dateOfLeaving: e.dateOfLeaving || null, email: e.email || null,
});

export const GET = route(
  async ({ orgId }) => ({ employees: await listEmployees(db, orgId, today()) }),
  { permission: { module: 'payroll', action: 'view' } },
);

const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), employee: Employee, salary: Structure }),
  z.object({ action: z.literal('update'), id: z.coerce.number().int().positive(), employee: Employee }),
  z.object({ action: z.literal('salary'), id: z.coerce.number().int().positive(), salary: Structure.extend({ effectiveFrom: date }) }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    return transaction(async (trx) => {
      const audit = (id: number, label: string, detail: string) => logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: input.action === 'create' ? 'create' : 'update',
        targetType: 'employee', targetId: id, targetLabel: label, detail, ...auditMeta(req),
      });
      if (input.action === 'create') {
        const id = await createEmployee(trx, orgId, clean(input.employee), { ...input.salary, effectiveFrom: input.employee.dateOfJoining });
        await audit(id, input.employee.name, `Employee ${input.employee.code} added`);
        return { id: String(id) };
      }
      if (input.action === 'update') {
        await updateEmployee(trx, orgId, input.id, clean(input.employee));
        await audit(input.id, input.employee.name, `Employee ${input.employee.code} updated`);
        return { id: String(input.id) };
      }
      await setSalary(trx, orgId, input.id, input.salary);
      // The amounts stay out of the trail on purpose: salaries are confidential.
      await audit(input.id, String(input.id), `Salary structure set from ${input.salary.effectiveFrom}`);
      return { id: String(input.id) };
    });
  },
  { permission: { module: 'payroll', action: 'edit' } },
);
