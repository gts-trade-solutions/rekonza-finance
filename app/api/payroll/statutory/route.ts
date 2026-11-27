import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, forbidden } from '@/lib/server/http';
import { changeReason } from '@/lib/server/request-context';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { COMPONENT_LABEL, payStatutory, statutoryRegister } from '@/lib/server/payroll/statutory-dues';
import { deleteStatutoryPayment, updateStatutoryPayment } from '@/lib/server/payroll/changes';
import { esiReport, lwfReport, pfReport, ptReport, tdsRegister } from '@/lib/server/payroll/statutory-reports';
import { salaryTdsMonths } from '@/lib/server/payroll/salary-tds';

const nextMonth = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
};

// The payroll statutory registers (PF, ESI, PT, LWF, TDS on salary) and each
// month's dues against what has been paid; paying a due posts it to the ledger.
// See lib/server/payroll/statutory-dues.ts.

const Month = z.string().regex(/^\d{4}-\d{2}$/);

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({
      from: Month, to: Month,
      // The statutory reports (statutory-reports.ts): each register with its file and its tie to the ledger.
      view: z.enum(['register', 'pf', 'esi', 'pt', 'lwf', 'tds']).default('register'),
    }));
    switch (q.view) {
      case 'pf': return pfReport(db, orgId, q.from, q.to);
      case 'esi': return esiReport(db, orgId, q.from, q.to);
      case 'pt': return ptReport(db, orgId, q.from, q.to);
      case 'lwf': return lwfReport(db, orgId, q.from, q.to);
      case 'tds': {
        const months: string[] = [];
        for (let m = q.from; m <= q.to; m = nextMonth(m)) months.push(m);
        return { ...(await tdsRegister(db, orgId, q.from, q.to)), months: await salaryTdsMonths(db, orgId, months) };
      }
      default: return statutoryRegister(db, orgId, q.from, q.to);
    }
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

const Id = z.union([z.string(), z.number()]).transform(Number);

/** Correct a statutory payment: reversed and paid again on the same record (payroll/changes.ts). */
export const PUT = route(
  async ({ orgId, user, role, req }) => {
    if (!hasPermission(role, 'payroll', 'approve') || !hasPermission(role, 'banking', 'edit')) {
      throw forbidden('Changing a statutory payment needs payroll approval and banking rights.');
    }
    const input = await body(req, PayInput.extend({ id: Id }));
    return transaction(async (trx) => {
      await updateStatutoryPayment(trx, orgId, user.userId, input.id, input);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'statutory_payment', targetId: input.id,
        targetLabel: `${COMPONENT_LABEL[input.component]} ${input.period}`,
        detail: `Changed to ₹${(input.amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} paid on ${input.date}; its entry reversed and posted again`,
        ...auditMeta(req),
      });
      return { id: String(input.id) };
    });
  },
  { permission: { module: 'payroll', action: 'edit' } },
);

/** Delete a statutory payment entered in error: its entry reversed, the record kept (payroll/changes.ts). */
export const DELETE = route(
  async ({ orgId, user, role, req }) => {
    if (!hasPermission(role, 'banking', 'void')) throw forbidden('Deleting a statutory payment needs banking rights to delete.');
    const { id } = query(req, z.object({ id: Id }));
    const reason = changeReason();
    return transaction(async (trx) => {
      const r = await deleteStatutoryPayment(trx, orgId, user.userId, id, reason);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'void', targetType: 'statutory_payment', targetId: id,
        targetLabel: r.label, detail: `${r.label} payment of ₹${(r.amountPaise / 100).toFixed(2)} deleted; its entry reversed${reason ? `: ${reason}` : ''}`,
        ...auditMeta(req),
      });
      return { id: String(id), deleted: true };
    });
  },
  { permission: { module: 'payroll', action: 'void' } },
);
