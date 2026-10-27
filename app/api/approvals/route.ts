import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, asId, badRequest, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import {
  approvalHistory, approve, deleteRule, listRules, mayApprove, pendingApprovals, reject, saveRule, submitForApproval,
  type RuleDoc,
} from '@/lib/server/services/approvals';
import { approveHeldJournal, rejectHeldJournal } from '@/lib/server/services/held-journals';
import { approveBatch, rejectBatch } from '@/lib/server/services/payment-batches';
import { postInvoice } from '@/lib/server/services/sales';
import { postBill } from '@/lib/server/services/purchases';

// Approvals: the rules, what is waiting, and the steps a document goes through.
// Who may approve is the rule's business, checked by the service; this route
// only makes sure the caller can see the kind of document at all.

const MODULE: Record<RuleDoc, 'sales' | 'purchases' | 'accountant'> = { invoice: 'sales', bill: 'purchases', journal: 'accountant', payment_batch: 'purchases' };
const LABEL: Record<RuleDoc, string> = { invoice: 'Invoices', bill: 'Bills', journal: 'Journals', payment_batch: 'Payment batches' };

export const GET = route(async ({ orgId, role, user, req }) => {
  const url = new URL(req.url);
  const doc = url.searchParams.get('doc') as RuleDoc | null;
  const id = Number(url.searchParams.get('id'));
  if (doc && id) {
    if (!hasPermission(role, MODULE[doc], 'view')) throw forbidden('You cannot see that document.');
    return { history: await approvalHistory(db, orgId, doc, id) };
  }
  const [rules, pending] = await Promise.all([listRules(db, orgId), pendingApprovals(db, orgId)]);
  return {
    rules,
    pending: pending
      .filter((p) => hasPermission(role, MODULE[p.documentType], 'view'))
      .map((p) => ({
        ...p,
        // Whether the person looking can approve it: their role, and not their own.
        canApprove: !!p.approverRole && mayApprove(role, p.approverRole) && p.submittedById !== String(user.userId),
      })),
    canEditRules: hasPermission(role, 'settings', 'edit'),
  };
});

const DOC = z.enum(['invoice', 'bill', 'journal', 'payment_batch']);
const Input = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save-rule'),
    id: z.union([z.string(), z.number()]).nullish(),
    documentType: DOC,
    thresholdPaise: z.number().int().nonnegative(),
    approverRole: z.enum(['admin', 'accountant', 'sales', 'staff']),
    isActive: z.boolean().default(true),
  }),
  z.object({ action: z.literal('delete-rule'), id: z.union([z.string(), z.number()]) }),
  z.object({ action: z.literal('submit'), doc: DOC, id: z.union([z.string(), z.number()]) }),
  z.object({ action: z.literal('approve'), doc: DOC, id: z.union([z.string(), z.number()]), note: z.string().max(500).nullish() }),
  z.object({ action: z.literal('reject'), doc: DOC, id: z.union([z.string(), z.number()]), reason: z.string().max(500) }),
]);

export const POST = route(async ({ orgId, user, role, req }) => {
  const input = await body(req, Input);
  const meta = auditMeta(req);

  if (input.action === 'save-rule' || input.action === 'delete-rule') {
    if (!hasPermission(role, 'settings', 'edit')) throw forbidden('Only an admin can change approval rules.');
    const id = await transaction(async (trx) => {
      if (input.action === 'delete-rule') {
        await deleteRule(trx, orgId, Number(input.id));
        await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'approval_rule', targetId: Number(input.id), detail: 'Deleted an approval rule', ...meta });
        return Number(input.id);
      }
      const saved = await saveRule(trx, orgId, {
        id: input.id ? Number(input.id) : null, documentType: input.documentType,
        thresholdPaise: input.thresholdPaise, approverRole: input.approverRole, isActive: input.isActive,
      });
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'approval_rule', targetId: saved,
        detail: `${LABEL[input.documentType]} of ${(input.thresholdPaise / 100).toFixed(2)} and above need ${input.approverRole} approval${input.isActive ? '' : ' (off)'}`,
        ...meta,
      });
      return saved;
    });
    return { id: asId(id) };
  }

  const id = Number(input.id);
  const area = MODULE[input.doc];
  if (!hasPermission(role, area, 'view')) throw forbidden('You cannot see that document.');

  await transaction(async (trx) => {
    const doc = input.doc;
    if (input.action === 'submit') {
      if (!hasPermission(role, area, 'create')) throw forbidden('You cannot submit that document.');
      // A journal is held for approval when it is entered; there is no draft to submit.
      if (doc === 'journal' || doc === 'payment_batch') throw badRequest('That goes for approval from its own screen.');
      await submitForApproval(trx, orgId, user.userId, doc, id);
    } else if (input.action === 'approve') {
      if (doc === 'journal') await approveHeldJournal(trx, orgId, { userId: user.userId, role }, id, input.note);
      else if (doc === 'payment_batch') await approveBatch(trx, orgId, { userId: user.userId, role }, id, input.note);
      else await approve(trx, orgId, { userId: user.userId, role }, doc, id, doc === 'invoice' ? postInvoice : postBill, input.note);
    } else if (doc === 'journal') {
      await rejectHeldJournal(trx, orgId, { userId: user.userId, role }, id, input.reason);
    } else if (doc === 'payment_batch') {
      await rejectBatch(trx, orgId, { userId: user.userId, role }, id, input.reason);
    } else {
      await reject(trx, orgId, { userId: user.userId, role }, doc, id, input.reason);
    }
    await logAudit({
      trx, orgId, actorUserId: user.userId, actorName: user.name,
      action: input.action === 'approve' ? 'approve' : 'update',
      targetType: input.doc === 'journal' ? 'held_journal' : input.doc, targetId: id,
      detail: input.action === 'submit' ? 'Submitted for approval'
        : input.action === 'approve' ? `${input.doc === 'payment_batch' ? 'Released to the bank' : 'Approved and posted'}${input.note ? ` — ${input.note}` : ''}`
        : `Sent back: ${input.reason}`,
      ...meta,
    });
  });
  return { ok: true };
});
