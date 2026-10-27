import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { billFromGoodsReceipt, cancelGoodsReceipt, receiveGoods } from '@/lib/server/services/order-flow';

// Goods receipt notes: goods in the store whose bill may not have come yet.

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.');

const ListQuery = z.object({
  status: z.enum(['open', 'partially_billed', 'billed', 'cancelled']).optional(),
  vendorId: z.string().optional(),
});

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, ListQuery);
    const rows = await db.selectFrom('goods_receipts as g')
      .innerJoin('contacts as c', 'c.id', 'g.vendor_id')
      .leftJoin('purchase_orders as po', 'po.id', 'g.source_po_id')
      .select([
        'g.id', 'g.number', 'g.receipt_date', 'g.status', 'g.total', 'g.vendor_challan_no', 'g.vendor_id',
        'c.display_name as vendor_name', 'po.number as po_number', 'g.source_po_id',
      ])
      .where('g.org_id', '=', orgId)
      .$if(!!q.status, (x) => x.where('g.status', '=', q.status!))
      .$if(!!q.vendorId, (x) => x.where('g.vendor_id', '=', Number(q.vendorId)))
      .orderBy('g.receipt_date', 'desc').orderBy('g.id', 'desc')
      .limit(500)
      .execute();
    return {
      receipts: rows.map((r) => ({
        id: asId(r.id),
        number: r.number,
        date: String(r.receipt_date).slice(0, 10),
        status: r.status,
        totalPaise: toPaiseFromSql(r.total),
        vendorChallanNo: r.vendor_challan_no,
        vendorId: asId(r.vendor_id),
        vendorName: r.vendor_name,
        poId: r.source_po_id ? asId(r.source_po_id) : null,
        poNumber: r.po_number,
      })),
    };
  },
  { permission: { module: 'purchases', action: 'view' } },
);

const CreateInput = z.object({
  branchId: z.union([z.string(), z.number()]).optional(),
  warehouseId: z.union([z.string(), z.number()]).nullish(),
  vendorId: z.union([z.string(), z.number()]),
  date: DATE,
  vendorChallanNo: z.string().trim().max(50).nullish(),
  notes: z.string().nullish(),
  lines: z.array(z.object({
    itemId: z.union([z.string(), z.number()]).nullish(),
    description: z.string().nullish(),
    hsnSac: z.string().nullish(),
    qty: z.number().positive(),
    uqc: z.string().nullish(),
    ratePaise: z.number().int().nonnegative().optional(),
    gstRatePct: z.number().min(0).max(40).optional(),
    /** A batch-tracked item: the batch it arrived in. */
    batch: z.object({ batchNo: z.string().trim().min(1).max(50), mfgDate: DATE.nullish(), expiryDate: DATE.nullish() }).nullish(),
    /** A serial-tracked item: the number of each piece, one per unit. */
    serials: z.array(z.string().trim().min(1).max(80)).max(5000).nullish(),
  })).min(1, 'Add at least one line.'),
});

export const POST = route(
  async ({ orgId, user, branchId, req }) => {
    const input = await body(req, CreateInput);
    const created = await transaction((trx) =>
      receiveGoods(trx, orgId, user.userId, {
        branchId: input.branchId ? Number(input.branchId) : branchId,
        warehouseId: input.warehouseId ? Number(input.warehouseId) : null,
        vendorId: Number(input.vendorId), date: input.date, vendorChallanNo: input.vendorChallanNo, notes: input.notes,
        lines: input.lines.map((l) => ({ ...l, itemId: l.itemId ? Number(l.itemId) : null })),
      }),
    );
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
      targetType: 'goods_receipt', targetId: created.id, targetLabel: created.number,
      detail: `Goods received on ${created.number}`, ...auditMeta(req),
    });
    return { id: asId(created.id), number: created.number, totalPaise: created.totalPaise };
  },
  { permission: { module: 'purchases', action: 'create' } },
);

const ActionInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('bill'),
    id: z.union([z.string(), z.number()]),
    vendorInvoiceNo: z.string().trim().min(1, "The supplier's invoice number is required."),
    date: DATE,
    dueDate: DATE,
    lines: z.array(z.object({
      lineId: z.union([z.string(), z.number()]),
      qty: z.number().positive(),
      ratePaise: z.number().int().nonnegative().optional(),
    })).optional(),
  }),
  z.object({ action: z.literal('cancel'), id: z.union([z.string(), z.number()]), reason: z.string().nullish() }),
]);

export const PATCH = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, ActionInput);
    const id = Number(input.id);
    if (input.action === 'cancel') {
      await transaction(async (trx) => {
        await cancelGoodsReceipt(trx, orgId, user.userId, id, input.reason ?? undefined);
        await logAudit({
          trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'void',
          targetType: 'goods_receipt', targetId: id, detail: input.reason ?? 'Goods receipt cancelled', ...auditMeta(req),
        });
      });
      return { ok: true };
    }
    const bill = await transaction((trx) =>
      billFromGoodsReceipt(trx, orgId, user.userId, id, {
        vendorInvoiceNo: input.vendorInvoiceNo, date: input.date, dueDate: input.dueDate,
        lines: input.lines?.map((l) => ({ lineId: Number(l.lineId), qty: l.qty, ratePaise: l.ratePaise })),
      }),
    );
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
      targetType: 'bill', targetId: bill.id, targetLabel: bill.internalNo,
      detail: `Bill ${bill.internalNo} for goods receipt #${id}` + (bill.match.status === 'exception' ? ` — held: ${bill.match.note}` : ''),
      ...auditMeta(req),
    });
    return { billId: asId(bill.id), internalNo: bill.internalNo, totalPaise: bill.totalPaise, match: bill.match, heldForApproval: bill.heldForApproval };
  },
  { permission: { module: 'purchases', action: 'edit' } },
);
