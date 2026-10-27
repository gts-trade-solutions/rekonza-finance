import { z } from 'zod';
import { sql } from 'kysely';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, badRequest } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { logAudit, auditMeta } from '@/lib/server/audit';
import {
  createPurchaseOrder, createVendorCredit, refundVendorCredit, voidVendorCredit,
} from '@/lib/server/services/purchase-documents';
import { billFromPurchaseOrder, receiveFromPurchaseOrder } from '@/lib/server/services/order-flow';

// ─────────────────────────────────────────────────────────────────────────────
// Purchase orders and vendor credits — the buy-side mirror of
// /api/sales-documents, and the same shape for the same reason.
// ─────────────────────────────────────────────────────────────────────────────

const KINDS = ['purchase-order', 'vendor-credit'] as const;
type Kind = (typeof KINDS)[number];

const SPEC: Record<Kind, { table: 'purchase_orders' | 'vendor_credits'; dateCol: string }> = {
  'purchase-order': { table: 'purchase_orders', dateCol: 'order_date' },
  'vendor-credit': { table: 'vendor_credits', dateCol: 'credit_date' },
};

const ListQuery = z.object({
  kind: z.enum(KINDS),
  from: z.string().optional(),
  to: z.string().optional(),
  status: z.string().optional(),
  vendorId: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, ListQuery);
    const spec = SPEC[q.kind];

    // The table is chosen from the map above, never from the request; every
    // value below is a bound parameter.
    const t = sql.raw(spec.table);
    const dateCol = sql.raw(`d.${spec.dateCol}`);

    const where: ReturnType<typeof sql>[] = [sql`d.org_id = ${orgId}`];
    if (q.from) where.push(sql`${dateCol} >= ${q.from}`);
    if (q.to) where.push(sql`${dateCol} <= ${q.to}`);
    if (q.status && q.status !== 'all') where.push(sql`d.status = ${q.status}`);
    if (q.vendorId) where.push(sql`d.vendor_id = ${Number(q.vendorId)}`);
    if (q.search) {
      const term = `%${q.search}%`;
      where.push(sql`(d.number LIKE ${term} OR c.display_name LIKE ${term})`);
    }
    const clause = sql.join(where, sql` AND `);

    const extra =
      q.kind === 'purchase-order'
        ? sql`, d.expected_date AS expected, d.subtotal, NULL AS reason, NULL AS linked, d.billed_amount AS applied`
        : sql`, NULL AS expected, d.total AS subtotal, d.reason, d.against_bill_id AS linked, d.applied_amount AS applied`;

    const { rows } = await sql<{
      id: number; number: string; dt: string; status: string; vendor_id: number;
      vendor_name: string; is_msme: number; total: string; subtotal: string;
      expected: string | null; reason: string | null; linked: number | null; applied: string;
    }>`
      SELECT d.id, d.number, ${dateCol} AS dt, d.status, d.vendor_id,
             c.display_name AS vendor_name, c.is_msme, d.total ${extra}
        FROM ${t} d
        JOIN contacts c ON c.id = d.vendor_id
       WHERE ${clause}
       ORDER BY ${dateCol} DESC, d.id DESC
       LIMIT ${q.limit}
    `.execute(db);

    const { rows: counts } = await sql<{ status: string; n: string }>`
      SELECT d.status, COUNT(*) AS n FROM ${t} d WHERE d.org_id = ${orgId} GROUP BY d.status
    `.execute(db);

    const statusCounts: Record<string, number> = { all: 0 };
    for (const c of counts) {
      statusCounts[c.status] = Number(c.n);
      statusCounts.all += Number(c.n);
    }

    return {
      kind: q.kind,
      documents: rows.map((r) => ({
        id: asId(r.id),
        number: r.number,
        date: String(r.dt).slice(0, 10),
        status: r.status,
        vendorId: asId(r.vendor_id),
        vendorName: r.vendor_name,
        isMsme: !!r.is_msme,
        subtotalPaise: toPaiseFromSql(r.subtotal),
        totalPaise: toPaiseFromSql(r.total),
        appliedPaise: toPaiseFromSql(r.applied),
        expected: r.expected ? String(r.expected).slice(0, 10) : null,
        reason: r.reason,
        linkedId: r.linked === null ? null : asId(r.linked),
      })),
      statusCounts,
      summary: {
        count: rows.length,
        totalPaise: rows.reduce((t2, r) => t2 + toPaiseFromSql(r.total), 0),
        openPaise: rows
          .filter((r) => !['void', 'cancelled', 'billed', 'closed'].includes(r.status))
          .reduce((t2, r) => t2 + toPaiseFromSql(r.total), 0),
      },
    };
  },
  { permission: { module: 'purchases', action: 'view' } },
);

const LineInput = z.object({
  itemId: z.union([z.string(), z.number()]).nullish(),
  description: z.string().nullish(),
  hsnSac: z.string().nullish(),
  qty: z.number().positive(),
  uqc: z.string().nullish(),
  ratePaise: z.number().int().nonnegative().optional(),
  discountPct: z.number().min(0).max(100).optional(),
  gstRatePct: z.number().min(0).max(50).optional(),
  cessRatePct: z.number().min(0).max(300).optional(),
});

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Give the date as yyyy-mm-dd.');
const toNum = (v: string | number | null | undefined) => (v == null ? null : Number(v));

const CreateInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('purchase-order'),
    branchId: z.union([z.string(), z.number()]),
    vendorId: z.union([z.string(), z.number()]),
    date: DATE,
    expectedDate: DATE.nullish(),
    lines: z.array(LineInput).min(1),
    notes: z.string().nullish(),
    voucherTypeId: z.union([z.string(), z.number()]).nullish(),
  }),
  z.object({
    kind: z.literal('vendor-credit'),
    branchId: z.union([z.string(), z.number()]),
    vendorId: z.union([z.string(), z.number()]),
    date: DATE,
    reason: z.string().trim().min(1, 'Say why the supplier is crediting you.').max(200),
    againstBillId: z.union([z.string(), z.number()]).nullish(),
    amountPaise: z.number().int().positive(),
    gstRatePct: z.number().min(0).max(50).optional(),
    itcClaimed: z.boolean().optional(),
    applyImmediately: z.boolean().optional(),
  }),
]);

export const POST = route(
  async ({ orgId, user, branchId, req }) => {
    const input = await body(req, CreateInput);
    const branch = Number(input.branchId ?? branchId) || branchId;
    const vendorId = Number(input.vendorId);

    const created = await transaction(async (trx) => {
      if (input.kind === 'purchase-order') {
        return createPurchaseOrder(trx, orgId, user.userId, {
          branchId: branch, vendorId, date: input.date,
          expectedDate: input.expectedDate ?? null,
          notes: input.notes,
          voucherTypeId: toNum(input.voucherTypeId),
          lines: input.lines.map((l) => ({ ...l, itemId: toNum(l.itemId) })),
        });
      }
      return createVendorCredit(trx, orgId, user.userId, {
        branchId: branch, vendorId, date: input.date, reason: input.reason,
        againstBillId: toNum(input.againstBillId),
        amountPaise: input.amountPaise,
        gstRatePct: input.gstRatePct,
        itcClaimed: input.itcClaimed,
        applyImmediately: input.applyImmediately,
      });
    });

    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
      targetType: input.kind, targetId: created.id, targetLabel: created.number,
      detail: `${input.kind.replace('-', ' ')} ${created.number} for ${(created.totalPaise / 100).toFixed(2)}`,
      ...auditMeta(req),
    });

    return {
      id: asId(created.id),
      number: created.number,
      totalPaise: created.totalPaise,
      journalEntryId: created.journalEntryId === null ? null : asId(created.journalEntryId),
    };
  },
  { permission: { module: 'purchases', action: 'create' } },
);

const BATCH = z.object({ batchNo: z.string().trim().min(1).max(50), mfgDate: DATE.nullish(), expiryDate: DATE.nullish() });

/** Which lines, how much of each, and the supplier's price where it differs. */
const LINES = z.array(z.object({
  lineId: z.union([z.string(), z.number()]),
  qty: z.number().positive(),
  ratePaise: z.number().int().nonnegative().optional(),
  /** Receiving a batch-tracked item: the batch it arrived in. */
  batch: BATCH.nullish(),
})).optional();
const picks = (lines: z.infer<typeof LINES>) =>
  lines?.map((l) => ({ lineId: Number(l.lineId), qty: l.qty, ratePaise: l.ratePaise, batch: l.batch ?? null }));

const ActionInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('convert'),
    id: z.union([z.string(), z.number()]),
    vendorInvoiceNo: z.string().trim().min(1, "The supplier's invoice number is required."),
    date: DATE,
    dueDate: DATE,
    lines: LINES,
  }),
  z.object({
    action: z.literal('receive'),
    id: z.union([z.string(), z.number()]),
    date: DATE,
    vendorChallanNo: z.string().trim().max(50).nullish(),
    notes: z.string().nullish(),
    lines: LINES,
  }),
  z.object({
    action: z.literal('refund-vendor-credit'),
    id: z.union([z.string(), z.number()]),
    bankAccountId: z.union([z.string(), z.number()]),
    date: DATE,
    amountPaise: z.number().int().positive().optional(),
    reference: z.string().nullish(),
  }),
  z.object({
    action: z.literal('void-vendor-credit'),
    id: z.union([z.string(), z.number()]),
    reason: z.string().nullish(),
  }),
  z.object({
    action: z.literal('set-status'),
    id: z.union([z.string(), z.number()]),
    status: z.enum(['open', 'closed', 'cancelled']),
  }),
]);

export const PATCH = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, ActionInput);
    const id = Number(input.id);

    switch (input.action) {
      case 'convert': {
        const bill = await transaction((trx) =>
          billFromPurchaseOrder(trx, orgId, user.userId, id, {
            vendorInvoiceNo: input.vendorInvoiceNo,
            date: input.date,
            dueDate: input.dueDate,
            lines: picks(input.lines),
          }),
        );
        await logAudit({
          orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
          targetType: 'bill', targetId: bill.id, targetLabel: bill.internalNo,
          detail: `Bill ${bill.internalNo} against purchase order #${id}` +
            (bill.match.status === 'exception' ? ` — held: ${bill.match.note}` : ''),
          ...auditMeta(req),
        });
        return { billId: asId(bill.id), internalNo: bill.internalNo, totalPaise: bill.totalPaise, match: bill.match, heldForApproval: bill.heldForApproval };
      }

      case 'receive': {
        const grn = await transaction((trx) =>
          receiveFromPurchaseOrder(trx, orgId, user.userId, id, {
            date: input.date, vendorChallanNo: input.vendorChallanNo, notes: input.notes,
            lines: picks(input.lines)?.map(({ lineId, qty, batch }) => ({ lineId, qty, batch })),
          }),
        );
        await logAudit({
          orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
          targetType: 'goods_receipt', targetId: grn.id, targetLabel: grn.number,
          detail: `Goods received on ${grn.number} against purchase order #${id}`, ...auditMeta(req),
        });
        return { receiptId: asId(grn.id), number: grn.number };
      }

      case 'refund-vendor-credit': {
        const r = await transaction((trx) =>
          refundVendorCredit(trx, orgId, user.userId, id, {
            bankAccountId: Number(input.bankAccountId),
            date: input.date,
            amountPaise: input.amountPaise,
            reference: input.reference ?? null,
          }),
        );
        return { refundedPaise: r.refundedPaise, journalEntryId: asId(r.journalEntryId) };
      }

      case 'void-vendor-credit': {
        await transaction((trx) => voidVendorCredit(trx, orgId, user.userId, id, input.reason ?? undefined));
        await logAudit({
          orgId, actorUserId: user.userId, actorName: user.name, action: 'void',
          targetType: 'vendor-credit', targetId: id, detail: input.reason ?? 'Vendor credit voided',
          ...auditMeta(req),
        });
        return { id: asId(id), status: 'void' };
      }

      case 'set-status': {
        // Only what a person legitimately sets by hand. 'billed' and
        // 'partially_billed' follow from converting, never from a request.
        const existing = await db
          .selectFrom('purchase_orders').select(['id', 'status'])
          .where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
        if (!existing) throw badRequest('That purchase order does not exist.');
        if (existing.status === 'billed') {
          throw badRequest('A fully billed order cannot be reopened or cancelled.');
        }
        await db
          .updateTable('purchase_orders').set({ status: input.status })
          .where('id', '=', id).where('org_id', '=', orgId).execute();
        return { id: asId(id), status: input.status };
      }
    }
  },
  { permission: { module: 'purchases', action: 'edit' } },
);
