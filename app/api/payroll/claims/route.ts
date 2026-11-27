import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { CLAIM_CATEGORIES, listClaims, reviewClaim, saveClaim } from '@/lib/server/payroll/claims';
import { deleteClaim, updateClaim } from '@/lib/server/payroll/changes';

// Expense claims, repaid with salary once approved.

export const GET = route(
  async ({ orgId }) => ({ claims: await listClaims(db, orgId), categories: CLAIM_CATEGORIES }),
  { permission: { module: 'payroll', action: 'view' } },
);

const Id = z.union([z.string(), z.number()]).transform(Number);

const ClaimInput = z.object({
  employeeId: Id, claimDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), category: z.string().max(60),
  description: z.string().max(300).nullish(), amountPaise: z.number().int().positive(),
});

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, ClaimInput);
    return transaction(async (trx) => {
      const id = await saveClaim(trx, orgId, user.userId, input);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'reimbursement_claim', targetId: id,
        targetLabel: `${input.category} claim`, detail: `Claimed ₹${(input.amountPaise / 100).toFixed(2)} for ${input.category}`, ...auditMeta(req),
      });
      return { id: asId(id) };
    });
  },
  { permission: { module: 'payroll', action: 'create' } },
);

export const PATCH = route(
  async ({ orgId, user, role, req }) => {
    if (!hasPermission(role, 'payroll', 'approve')) throw forbidden('Approving a claim needs approval rights in payroll.');
    const input = await body(req, z.object({ id: Id, approve: z.boolean(), note: z.string().max(300).nullish() }));
    return transaction(async (trx) => {
      await reviewClaim(trx, orgId, user.userId, input.id, input);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: input.approve ? 'approve' : 'update',
        targetType: 'reimbursement_claim', targetId: input.id, targetLabel: 'Expense claim',
        detail: input.approve ? 'Approved' : `Rejected: ${input.note}`, ...auditMeta(req),
      });
      return { id: asId(input.id) };
    });
  },
  { permission: { module: 'payroll', action: 'edit' } },
);

/** Correct a claim not yet repaid by a posted payroll; an approved one goes back to be approved (payroll/changes.ts). */
export const PUT = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, ClaimInput.extend({ id: Id }));
    return transaction(async (trx) => {
      const r = await updateClaim(trx, orgId, user.userId, input.id, input);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'reimbursement_claim', targetId: input.id,
        targetLabel: `${input.category} claim`,
        detail: `Changed to ₹${(input.amountPaise / 100).toFixed(2)} for ${input.category}${r.reopened ? '; back to be approved' : ''}`, ...auditMeta(req),
      });
      return { id: asId(input.id) };
    });
  },
  { permission: { module: 'payroll', action: 'edit' } },
);

/** Delete a claim not yet repaid by a posted payroll. */
export const DELETE = route(
  async ({ orgId, user, req }) => {
    const { id } = query(req, z.object({ id: Id }));
    return transaction(async (trx) => {
      const r = await deleteClaim(trx, orgId, user.userId, id);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'void', targetType: 'reimbursement_claim', targetId: id,
        targetLabel: `${r.category} claim`, detail: `Deleted the claim of ₹${(r.amountPaise / 100).toFixed(2)}`, ...auditMeta(req),
      });
      return { id: asId(id), deleted: true };
    });
  },
  { permission: { module: 'payroll', action: 'void' } },
);
