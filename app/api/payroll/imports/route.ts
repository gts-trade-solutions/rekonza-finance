import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { changeReason } from '@/lib/server/request-context';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { importPayroll, listImports, reverseImport } from '@/lib/server/payroll/payroll-import';
import { monthLabel } from '@/lib/date-range';

// Payroll run in another system, imported as the month's salary register: it
// posts the salary journal (and its payment, when given). See
// lib/server/payroll/payroll-import.ts.

const paise = z.number().int().min(0).optional();
const Row = z.object({
  code: z.string().trim().min(1).max(30), name: z.string().trim().min(1).max(150), department: z.string().trim().max(100).nullish(),
  basicPaise: paise, hraPaise: paise, otherPaise: paise, grossPaise: z.number().int().min(0),
  pfEmployeePaise: paise, pfEmployerPaise: paise, esiEmployeePaise: paise, esiEmployerPaise: paise, ptPaise: paise,
  lwfEmployeePaise: paise, lwfEmployerPaise: paise, tdsPaise: paise, advancePaise: paise, netPaise: z.number().int(),
});
const Input = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), sourceSystem: z.string().trim().max(60).nullish(), fileName: z.string().trim().max(200).nullish(),
  rows: z.array(Row).min(1).max(5000), dryRun: z.boolean().default(true),
  paidFromBankAccountId: z.union([z.string(), z.number()]).nullish().transform((v) => (v === null || v === undefined || v === '' ? null : Number(v))),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});

export const GET = route(
  async ({ orgId }) => ({ imports: await listImports(db, orgId) }),
  { permission: { module: 'payroll', action: 'view' } },
);

export const POST = route(
  async ({ orgId, user, role, req }) => {
    const input = await body(req, Input);
    if (!input.dryRun && !hasPermission(role, 'payroll', 'approve')) throw forbidden('Posting a salary register needs approval rights in payroll.');
    return transaction(async (trx) => {
      const r = await importPayroll(trx, orgId, user.userId, input, input.dryRun);
      if (r.posted) {
        await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'import', targetType: 'payroll_import', targetId: r.importId!,
          targetLabel: `Payroll ${input.month}`, detail: `Salary register for ${monthLabel(input.month)} imported${input.sourceSystem ? ` from ${input.sourceSystem}` : ''}: ${r.totals.employees} employees, gross ₹${(r.totals.grossPaise / 100).toLocaleString('en-IN')}, net ₹${(r.totals.netPaise / 100).toLocaleString('en-IN')}`,
          ...auditMeta(req) });
      }
      return { ...r, importId: r.importId ? String(r.importId) : null };
    });
  },
  { permission: { module: 'payroll', action: 'create' } },
);

/** Reverse an imported register (its entries reversed, the record kept). */
export const DELETE = route(
  async ({ orgId, user, role, req }) => {
    if (!hasPermission(role, 'payroll', 'approve')) throw forbidden('Reversing a salary register needs approval rights in payroll.');
    const { id } = query(req, z.object({ id: z.coerce.number().int().positive() }));
    const reason = changeReason();
    return transaction(async (trx) => {
      const r = await reverseImport(trx, orgId, user.userId, id, reason);
      await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'void', targetType: 'payroll_import', targetId: id,
        targetLabel: `Payroll ${r.month}`, detail: `Imported payroll for ${monthLabel(r.month)} reversed${reason ? `: ${reason}` : ''}`, ...auditMeta(req) });
      return { ok: true };
    });
  },
  { permission: { module: 'payroll', action: 'void' } },
);
