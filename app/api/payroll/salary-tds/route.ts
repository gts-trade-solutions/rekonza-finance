import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { changeReason } from '@/lib/server/request-context';
import { logAudit, auditMeta } from '@/lib/server/audit';
import {
  deleteSalaryChallan, form24Q, linkChallan, listSalaryChallans, recordSalaryChallan, setReturnReceipt, updateSalaryChallan, type Quarter,
} from '@/lib/server/payroll/salary-tds';

// ─────────────────────────────────────────────────────────────────────────────
// TDS on salary (section 192): challans ITNS 281 deposited, each employee's
// deduction linked to the challan that paid it, and Form 24Q by quarter
// (Annexure I by challan, Annexure II in the fourth). See
// lib/server/payroll/salary-tds.ts.
// ─────────────────────────────────────────────────────────────────────────────

const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Id = z.union([z.string(), z.number()]).transform(Number);
const currentFy = () => { const d = new Date(); return d.getMonth() < 3 ? d.getFullYear() - 1 : d.getFullYear(); };

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({
      view: z.enum(['challans', '24q']).default('challans'),
      fy: z.coerce.number().int().min(2017).max(2100).optional(),
      quarter: z.coerce.number().int().min(1).max(4).optional(),
    }));
    if (q.view === '24q') return form24Q(db, orgId, q.fy ?? currentFy(), (q.quarter ?? 1) as Quarter);
    return { challans: await listSalaryChallans(db, orgId) };
  },
  { permission: { module: 'payroll', action: 'view' } },
);

const ChallanInput = z.object({
  forMonth: Month, date: DATE, bsrCode: z.string().trim(), serial: z.string().trim(),
  taxPaise: z.number().int().min(0), surchargePaise: z.number().int().min(0).optional(), cessPaise: z.number().int().min(0).optional(),
  interestPaise: z.number().int().min(0).optional(), feePaise: z.number().int().min(0).optional(),
  bankAccountId: Id, notes: z.string().trim().max(300).nullish(),
});

const Action = z.discriminatedUnion('action', [
  ChallanInput.extend({ action: z.literal('challan') }),
  z.object({ action: z.literal('relink'), id: Id }),
  z.object({ action: z.literal('receipt'), fy: z.number().int().min(2017).max(2100), quarter: z.number().int().min(1).max(4), receiptNo: z.string().trim().min(8).max(20), filedOn: DATE.nullish() }),
]);

const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

export const POST = route(
  async ({ orgId, user, role, req }) => {
    const input = await body(req, Action);
    // Depositing tax moves money: payroll approval and banking rights, as paying the other dues.
    if (input.action === 'challan' && (!hasPermission(role, 'payroll', 'approve') || !hasPermission(role, 'banking', 'create'))) {
      throw forbidden('Recording a TDS challan needs payroll approval and banking rights.');
    }
    return transaction(async (trx) => {
      const audit = (action: 'create' | 'update', id: number, label: string, detail: string) => logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action, targetType: 'salary_tds_challan', targetId: id, targetLabel: label, detail, ...auditMeta(req),
      });
      if (input.action === 'challan') {
        const r = await recordSalaryChallan(trx, orgId, user.userId, input);
        await audit('create', r.id, `${input.bsrCode}/${input.serial}`,
          `TDS on salary for ${input.forMonth} deposited: ${rupees(input.taxPaise + (input.surchargePaise ?? 0) + (input.cessPaise ?? 0))}, challan ${input.bsrCode}/${input.date}/${input.serial}; ${r.linked} deduction(s) linked`);
        return { id: String(r.id), entryId: String(r.entryId), linked: r.linked, unallocatedPaise: r.unallocatedPaise };
      }
      if (input.action === 'relink') {
        const r = await linkChallan(trx, orgId, input.id);
        await audit('update', input.id, `Challan ${input.id}`, `Deductions linked again: ${r.linked}`);
        return r;
      }
      await setReturnReceipt(trx, orgId, user.userId, input.fy, input.quarter as Quarter, input.receiptNo, input.filedOn ?? null);
      await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'salary_tds_return', targetId: input.fy * 10 + input.quarter,
        targetLabel: `24Q FY ${input.fy} Q${input.quarter}`, detail: `Receipt number ${input.receiptNo}${input.filedOn ? `, filed ${input.filedOn}` : ''}`, ...auditMeta(req) });
      return { ok: true };
    });
  },
  { permission: { module: 'payroll', action: 'edit' } },
);

/** Correct a challan: its entry reversed and posted again, its links made afresh. */
export const PUT = route(
  async ({ orgId, user, role, req }) => {
    if (!hasPermission(role, 'payroll', 'approve') || !hasPermission(role, 'banking', 'edit')) {
      throw forbidden('Changing a TDS challan needs payroll approval and banking rights.');
    }
    const input = await body(req, ChallanInput.extend({ id: Id }));
    return transaction(async (trx) => {
      const r = await updateSalaryChallan(trx, orgId, user.userId, input.id, input, changeReason());
      await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'salary_tds_challan', targetId: input.id,
        targetLabel: `${input.bsrCode}/${input.serial}`, detail: `Challan changed; its entry reversed and posted again; ${r.linked} deduction(s) linked`, ...auditMeta(req) });
      return { id: String(input.id), entryId: String(r.entryId) };
    });
  },
  { permission: { module: 'payroll', action: 'edit' } },
);

/** Delete a challan entered in error: its entry reversed, kept in deleted documents. */
export const DELETE = route(
  async ({ orgId, user, role, req }) => {
    if (!hasPermission(role, 'banking', 'void')) throw forbidden('Deleting a TDS challan needs banking rights to delete.');
    const { id } = query(req, z.object({ id: Id }));
    const reason = changeReason();
    return transaction(async (trx) => {
      const r = await deleteSalaryChallan(trx, orgId, user.userId, id, reason);
      await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'void', targetType: 'salary_tds_challan', targetId: id,
        targetLabel: r.label, detail: `Challan ${r.label} of ${rupees(r.amountPaise)} deleted; its entry reversed${reason ? `: ${reason}` : ''}`, ...auditMeta(req) });
      return { id: String(id), deleted: true };
    });
  },
  { permission: { module: 'payroll', action: 'void' } },
);
