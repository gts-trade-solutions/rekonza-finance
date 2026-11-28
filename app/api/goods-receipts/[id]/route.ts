import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, idParam, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deleteGoodsReceipt, goodsReceiptForEdit, updateGoodsReceipt } from '@/lib/server/services/purchase-changes';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.');
const toNum = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? null : Number(v));

/** One receipt note with its lines, as entered: what its Edit window opens with. */
export const GET = route(
  async ({ orgId, params }) => goodsReceiptForEdit(db, orgId, idParam(params)),
  { permission: { module: 'purchases', action: 'view' } },
);

const EditInput = z.object({
  branchId: z.union([z.string(), z.number()]),
  warehouseId: z.union([z.string(), z.number()]).nullish(),
  vendorId: z.union([z.string(), z.number()]),
  date: DATE,
  vendorChallanNo: z.string().trim().max(50).nullish(),
  notes: z.string().nullish(),
  lines: z.array(z.object({
    /** Received against this purchase order line: kept as it was. */
    poLineId: z.union([z.string(), z.number()]).nullish(),
    itemId: z.union([z.string(), z.number()]).nullish(),
    description: z.string().nullish(),
    hsnSac: z.string().nullish(),
    qty: z.number().positive(),
    uqc: z.string().nullish(),
    ratePaise: z.number().int().nonnegative().optional(),
    gstRatePct: z.number().min(0).max(40).optional(),
    batch: z.object({ batchNo: z.string().trim().min(1).max(50), mfgDate: DATE.nullish(), expiryDate: DATE.nullish() }).nullish(),
    serials: z.array(z.string().trim().min(1).max(80)).max(5000).nullish(),
  })).min(1, 'Add at least one line.'),
});

/**
 * Edit, as Zoho Books' Edit: while nothing on the note is billed. Its stock
 * and "goods received, bill pending" entry is reversed and posted again; the
 * same number, its order lines kept.
 */
export const PUT = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const input = await body(req, EditInput);
    const done = await transaction(async (trx) => {
      const made = await updateGoodsReceipt(trx, orgId, user.userId, id, {
        branchId: Number(input.branchId), warehouseId: toNum(input.warehouseId), vendorId: Number(input.vendorId),
        date: input.date, vendorChallanNo: input.vendorChallanNo, notes: input.notes,
        lines: input.lines.map((l) => ({ ...l, poLineId: toNum(l.poLineId), itemId: toNum(l.itemId) })),
      });
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: 'goods_receipt', targetId: id, targetLabel: made.number,
        detail: `Edited goods receipt ${made.number}`, payload: { before: made.before, after: made.after }, ...auditMeta(req),
      });
      return made;
    });
    return { id: asId(done.id), number: done.number, totalPaise: done.totalPaise };
  },
  { permission: { module: 'purchases', action: 'edit' } },
);

/** Delete, as Zoho Books' Delete: while nothing on it is billed. The entry reversed, the record kept. */
export const DELETE = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const reason = new URL(req.url).searchParams.get('reason');
    const done = await transaction(async (trx) => {
      const gone = await deleteGoodsReceipt(trx, orgId, user.userId, id, reason);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete',
        targetType: 'goods_receipt', targetId: id, targetLabel: gone.number,
        detail: `Deleted goods receipt ${gone.number}${reason ? ` — ${reason}` : ''}`, ...auditMeta(req),
      });
      return gone;
    });
    return { deleted: true, number: done.number };
  },
  { permission: { module: 'purchases', action: 'void' } },
);
