import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import {
  bankFile, cancelBatch, createBatch, listBatches, markBatchPaid, payableBills, submitBatch,
} from '@/lib/server/services/payment-batches';

// Payment batches: choose bills, release them (with a second person where an
// approval rule asks), download the bank's bulk file, then mark the batch paid.
// Approving and sending back go through /api/approvals with the other documents.

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ view: z.enum(['batches', 'bills']).default('batches'), dueBy: z.string().optional() }));
    if (q.view === 'bills') return { bills: await payableBills(db, orgId, { dueBy: q.dueBy || null }) };
    const [batches, banks] = await Promise.all([
      listBatches(db, orgId),
      db.selectFrom('bank_accounts').select(['id', 'name', 'account_number', 'is_primary'])
        .where('org_id', '=', orgId).where('kind', '=', 'bank').where('is_active', '=', 1).orderBy('is_primary', 'desc').orderBy('name').execute(),
    ]);
    return {
      batches,
      bankAccounts: banks.map((b) => ({ id: asId(b.id), name: b.name, hasAccountNo: !!b.account_number })),
    };
  },
  { permission: { module: 'purchases', action: 'view' } },
);

const Id = z.union([z.string(), z.number()]);
const Input = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    bankAccountId: Id,
    payDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    notes: z.string().max(500).nullish(),
    lines: z.array(z.object({ billId: Id, amountPaise: z.number().int().positive() })).min(1, 'Choose at least one bill to pay.'),
  }),
  z.object({ action: z.literal('submit'), id: Id }),
  z.object({ action: z.literal('cancel'), id: Id }),
  z.object({ action: z.literal('file'), id: Id }),
  z.object({
    action: z.literal('paid'),
    id: Id,
    /** UTRs by supplier id, as the bank's report gives them. */
    references: z.record(z.string(), z.string().max(60)).optional(),
    /** Suppliers whose transfer the bank returned: their bills stay unpaid. */
    failedVendorIds: z.array(Id).optional(),
  }),
]);

export const POST = route(
  async ({ orgId, user, branchId, req }) => {
    const input = await body(req, Input);
    const meta = auditMeta(req);
    return transaction(async (trx) => {
      const audit = (id: number, detail: string, action: 'create' | 'update' | 'void' | 'approve' = 'update') =>
        logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action, targetType: 'payment_batch', targetId: id, detail, ...meta });

      if (input.action === 'create') {
        const made = await createBatch(trx, orgId, user.userId, {
          branchId, bankAccountId: Number(input.bankAccountId), payDate: input.payDate, notes: input.notes,
          lines: input.lines.map((l) => ({ billId: Number(l.billId), amountPaise: l.amountPaise })),
        });
        await audit(made.id, `Batch ${made.number} of ${input.lines.length} bill(s) for ${(made.totalPaise / 100).toFixed(2)}, paying ${input.payDate}`, 'create');
        return { id: asId(made.id), number: made.number };
      }
      const id = Number(input.id);
      if (input.action === 'submit') {
        const r = await submitBatch(trx, orgId, user.userId, id);
        await audit(id, r.status === 'pending' ? `Submitted for ${r.approverRole} approval` : 'Released to the bank (no approval rule covers it)', r.status === 'approved' ? 'approve' : 'update');
        return { id: asId(id), ...r };
      }
      if (input.action === 'cancel') {
        await cancelBatch(trx, orgId, id);
        await audit(id, 'Cancelled; its bills are free for another batch', 'void');
        return { id: asId(id), status: 'cancelled' as const };
      }
      if (input.action === 'file') {
        const file = await bankFile(trx, orgId, id);
        await audit(id, `Bank file downloaded: ${file.rows.length} transfer(s)`);
        return file;
      }
      const paid = await markBatchPaid(trx, orgId, user.userId, id, {
        references: input.references, failedVendorIds: input.failedVendorIds?.map(Number),
      });
      await audit(id, `Marked paid: ${paid.map((p) => p.number).join(', ')}${input.failedVendorIds?.length ? `; ${input.failedVendorIds.length} transfer(s) returned` : ''}`, 'create');
      return { id: asId(id), status: 'paid' as const, payments: paid.map((p) => ({ ...p, paymentId: asId(p.paymentId), vendorId: asId(p.vendorId) })) };
    });
  },
  { permission: { module: 'purchases', action: 'create' } },
);
