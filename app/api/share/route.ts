import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, forbidden } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { createDocumentLink, createPayslipLink, createShareLink, listShareLinks, revokeShareLinks } from '@/lib/server/services/sharing';
import { PRINT_KINDS, PRINT_NOUN, PRINT_SIDE, type PrintKind } from '@/lib/print-doc';
import { hasPermission } from '@/lib/rbac';

// Links that open one invoice, one other document (a quote, an order, a
// receipt …), or one payslip, without signing in: for sending it to the
// customer, the vendor or the employee.

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
      document: z.object({ kind: z.enum(PRINT_KINDS as [PrintKind, ...PrintKind[]]), id: z.coerce.number().int().positive() }).optional(),
    }));
    if (input.document) {
      const d = input.document;
      const area = PRINT_SIDE[d.kind] === 'customer' ? 'sales' : 'purchases';
      if (!hasPermission(role, area, 'export')) throw forbidden(`Sharing a document needs the right to export in ${area}.`);
      return transaction(async (trx) => {
        const link = await createDocumentLink(trx, orgId, user.userId, { kind: d.kind, id: d.id, days: input.days });
        await logAudit({
          trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'export', targetType: d.kind, targetId: d.id,
          detail: `Share link to the ${PRINT_NOUN[d.kind]} made, open until ${link.expiresAt.slice(0, 10)}`, ...auditMeta(req),
        });
        return link;
      });
    }
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
