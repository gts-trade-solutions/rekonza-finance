import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, idParam, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deletePurchaseOrder, purchaseOrderForEdit, updatePurchaseOrder } from '@/lib/server/services/purchase-changes';

// Zoho Books' Edit and Delete on a purchase order (services/purchase-changes.ts):
// while nothing on it has been received or billed. An order posts nothing, so
// neither moves the ledger; a deleted order is kept in deleted_documents.

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Give the date as yyyy-mm-dd.');
const toNum = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? null : Number(v));

/** The order as saved, for its Edit window. */
export const GET = route(
  async ({ orgId, params }) => purchaseOrderForEdit(db, orgId, idParam(params)),
  { permission: { module: 'purchases', action: 'view' } },
);

const EditInput = z.object({
  branchId: z.union([z.string(), z.number()]),
  vendorId: z.union([z.string(), z.number()]),
  date: DATE,
  expectedDate: DATE.nullish(),
  notes: z.string().max(2000).nullish(),
  /** A draft may be opened as it is saved; an open order stays open. */
  status: z.enum(['draft', 'open']).optional(),
  lines: z.array(z.object({
    itemId: z.union([z.string(), z.number()]).nullish(),
    description: z.string().max(500).nullish(),
    hsnSac: z.string().max(10).nullish(),
    qty: z.number().positive(),
    uqc: z.string().max(10).nullish(),
    ratePaise: z.number().int().nonnegative().optional(),
    discountPct: z.number().min(0).max(100).optional(),
    gstRatePct: z.number().min(0).max(50).optional(),
  })).min(1, 'Add at least one line.'),
});

export const PUT = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const input = await body(req, EditInput);
    const done = await transaction(async (trx) => {
      const made = await updatePurchaseOrder(trx, orgId, user.userId, id, {
        branchId: Number(input.branchId), vendorId: Number(input.vendorId), date: input.date,
        expectedDate: input.expectedDate ?? null, notes: input.notes ?? null, status: input.status,
        lines: input.lines.map((l) => ({ ...l, itemId: toNum(l.itemId) })),
      });
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: 'purchase-order', targetId: id, targetLabel: made.number,
        detail: `Edited purchase order ${made.number}: ₹${(made.totalPaise / 100).toFixed(2)}`,
        payload: { before: made.before, after: made.after }, ...auditMeta(req),
      });
      return made;
    });
    return { id: asId(done.id), number: done.number, totalPaise: done.totalPaise };
  },
  { permission: { module: 'purchases', action: 'edit' } },
);

export const DELETE = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const reason = new URL(req.url).searchParams.get('reason');
    const done = await transaction(async (trx) => {
      const gone = await deletePurchaseOrder(trx, orgId, user.userId, id, reason);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete',
        targetType: 'purchase-order', targetId: id, targetLabel: gone.number,
        detail: `Deleted purchase order ${gone.number}${reason ? ` — ${reason}` : ''}`, ...auditMeta(req),
      });
      return gone;
    });
    return { deleted: true, number: done.number };
  },
  { permission: { module: 'purchases', action: 'void' } },
);
