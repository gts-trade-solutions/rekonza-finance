import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, forbidden } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { createPayslipLink, createShareLink, listShareLinks, revokeShareLinks } from '@/lib/server/services/sharing';
import { hasPermission } from '@/lib/rbac';

// Links that open one invoice, or one payslip, without signing in: for sending
// it to the customer or the employee.

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ invoiceId: z.coerce.number().int().positive() }));
    return { links: await listShareLinks(db, orgId, q.invoiceId) };
  },
  { permission: { module: 'sales', action: 'view' } },
);

// Sending a copy outside the business is exporting it: an invoice needs that
// right in sales, a payslip in payroll.
export const POST = route(
  async ({ orgId, user, role, req }) => {
    const input = await body(req, z.object({
      invoiceId: z.coerce.number().int().positive().optional(), days: z.number().int().min(1).max(180).optional(),
      payslip: z.object({ runId: z.coerce.number().int().positive(), employeeId: z.coerce.number().int().positive() }).optional(),
    }));
    if (input.payslip) {
      if (!hasPermission(role, 'payroll', 'export')) throw forbidden('Sending payslips needs the right to export in payroll.');
      const slip = input.payslip;
      return transaction(async (trx) => {
        const link = await createPayslipLink(trx, orgId, user.userId, slip);
        await logAudit({
          trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'export', targetType: 'payroll', targetId: slip.runId,
          detail: `Payslip link made for employee ${slip.employeeId}, open until ${link.expiresAt.slice(0, 10)}`, ...auditMeta(req),
        });
        return link;
      });
    }
    if (!input.invoiceId) throw forbidden('Say which invoice or payslip to share.');
    if (!hasPermission(role, 'sales', 'export')) throw forbidden('Sharing an invoice needs the right to export in sales.');
    const invoiceId = input.invoiceId;
    return transaction(async (trx) => {
      const link = await createShareLink(trx, orgId, user.userId, { invoiceId, days: input.days });
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'export', targetType: 'invoice', targetId: invoiceId,
        detail: `Share link made, open until ${link.expiresAt.slice(0, 10)}`, ...auditMeta(req),
      });
      return link;
    });
  },
  {},
);

export const PATCH = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, z.object({ invoiceId: z.coerce.number().int().positive() }));
    return transaction(async (trx) => {
      const n = await revokeShareLinks(trx, orgId, input.invoiceId);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'invoice', targetId: input.invoiceId,
        detail: `${n} share link${n === 1 ? '' : 's'} revoked`, ...auditMeta(req),
      });
      return { revoked: n };
    });
  },
  { permission: { module: 'sales', action: 'edit' } },
);
