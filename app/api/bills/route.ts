import { z } from 'zod';
import { sql } from 'kysely';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { createBill } from '@/lib/server/services/purchases';
import { logAudit, auditMeta } from '@/lib/server/audit';

const ListQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  status: z.string().optional(),
  /** Issued and not yet fully settled — what a payment screen can be applied to. */
  open: z.coerce.boolean().optional(),
  vendorId: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, ListQuery);

    let base = db
      .selectFrom('bills')
      .innerJoin('contacts', 'contacts.id', 'bills.vendor_id')
      .where('bills.org_id', '=', orgId);

    if (q.from) base = base.where('bills.bill_date', '>=', q.from);
    if (q.to) base = base.where('bills.bill_date', '<=', q.to);
    if (q.status && q.status !== 'all') base = base.where('bills.status', '=', q.status as never);
    if (q.open) {
      // A draft was never issued and a void one was cancelled, so neither can
      // be paid. Everything else with a balance is fair game.
      base = base
        .where('bills.status', 'not in', ['draft', 'void'])
        .where((eb) => eb(eb.ref('bills.total'), '>', eb.ref('bills.amount_paid')));
    }
    if (q.vendorId) base = base.where('bills.vendor_id', '=', Number(q.vendorId));
    if (q.search) {
      const term = `%${q.search}%`;
      base = base.where((eb) =>
        eb.or([
          eb('bills.internal_no', 'like', term),
          eb('bills.vendor_invoice_no', 'like', term),
          eb('contacts.display_name', 'like', term),
        ]),
      );
    }

    const [rows, totals] = await Promise.all([
      base
        .select([
          'bills.id', 'bills.internal_no', 'bills.vendor_invoice_no', 'bills.bill_date',
          'bills.due_date', 'bills.status', 'bills.is_rcm', 'bills.subtotal', 'bills.total',
          'bills.amount_paid', 'bills.tds_amount', 'bills.tds_section', 'bills.vendor_id',
          'bills.currency', 'bills.fc_total', 'bills.fc_amount_paid',
          'contacts.display_name as vendor_name', 'contacts.is_msme',
        ])
        .orderBy('bills.bill_date', 'desc')
        .orderBy('bills.id', 'desc')
        .limit(q.limit)
        .offset(q.offset)
        .execute(),
      base
        .select([
          sql<string>`COUNT(*)`.as('count'),
          sql<string>`COALESCE(SUM(bills.total), 0)`.as('total'),
          sql<string>`COALESCE(SUM(bills.total - bills.amount_paid), 0)`.as('due'),
        ])
        .executeTakeFirst(),
    ]);

    return {
      bills: rows.map((r) => ({
        id: asId(r.id),
        internalNo: r.internal_no,
        vendorInvoiceNo: r.vendor_invoice_no,
        date: r.bill_date,
        dueDate: r.due_date,
        status: r.status,
        isRcm: !!r.is_rcm,
        vendorId: asId(r.vendor_id),
        vendorName: r.vendor_name,
        isMsme: !!r.is_msme,
        subtotalPaise: toPaiseFromSql(r.subtotal),
        totalPaise: toPaiseFromSql(r.total),
        amountPaidPaise: toPaiseFromSql(r.amount_paid),
        balancePaise: toPaiseFromSql(r.total) - toPaiseFromSql(r.amount_paid),
        currency: r.currency,
        // In the bill's own currency, for one priced in another.
        fcBalancePaise: r.currency === 'INR' ? null : toPaiseFromSql(r.fc_total ?? '0') - toPaiseFromSql(r.fc_amount_paid),
        tdsPaise: toPaiseFromSql(r.tds_amount),
        tdsSection: r.tds_section,
      })),
      summary: {
        count: Number(totals?.count ?? 0),
        totalPaise: toPaiseFromSql(totals?.total ?? '0'),
        duePaise: toPaiseFromSql(totals?.due ?? '0'),
      },
    };
  },
  { permission: { module: 'purchases', action: 'view' } },
);

const LineInput = z.object({
  itemId: z.string().nullish(),
  accountId: z.string().nullish(),
  description: z.string().nullish(),
  hsnSac: z.string().nullish(),
  qty: z.number().positive('Quantity must be above zero.'),
  uqc: z.string().nullish(),
  ratePaise: z.number().int().nonnegative(),
  discountPct: z.number().min(0).max(100).optional(),
  gstRatePct: z.number().min(0).max(50).optional(),
  cessRatePct: z.number().min(0).max(300).optional(),
  itcEligibility: z.enum(['eligible', 'ineligible', 'capital_goods']).optional(),
  /** A batch-tracked item: the batch bought and its dates. */
  batch: z.object({ batchNo: z.string().trim().max(40), mfgDate: z.string().nullish(), expiryDate: z.string().nullish() }).nullish(),
  /** A serial-tracked item: the number of each piece, one per unit. */
  serials: z.array(z.string().trim().min(1).max(80)).max(5000).nullish(),
});

const CreateInput = z.object({
  branchId: z.string(),
  vendorId: z.string(),
  /** The cost centre the document's income or expense belongs to. */
  costCentreId: z.union([z.string(), z.number()]).nullish(),
  warehouseId: z.union([z.string(), z.number()]).nullish(),
  vendorInvoiceNo: z.string().min(1, "Enter the vendor's invoice number."),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.'),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.'),
  lines: z.array(LineInput).min(1, 'Add at least one line.'),
  isRcm: z.boolean().optional(),
  tdsSectionOverride: z.string().nullish(),
  notes: z.string().nullish(),
  status: z.enum(['draft', 'open']).optional(),
  /** Priced in another currency: amounts in its minor unit, booked in rupees at the rate. */
  currency: z.string().trim().toUpperCase().length(3).optional(),
  exchangeRate: z.number().positive().optional(),
});

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, CreateInput);

    const created = await transaction(async (trx) =>
      createBill(trx, orgId, user.userId, {
        branchId: Number(input.branchId),
        costCentreId: input.costCentreId ? Number(input.costCentreId) : null,
        warehouseId: input.warehouseId ? Number(input.warehouseId) : null,
        vendorId: Number(input.vendorId),
        vendorInvoiceNo: input.vendorInvoiceNo,
        date: input.date,
        dueDate: input.dueDate,
        isRcm: input.isRcm,
        tdsSectionOverride: input.tdsSectionOverride,
        currency: input.currency,
        exchangeRate: input.exchangeRate,
        notes: input.notes,
        status: input.status,
        lines: input.lines.map((l) => ({
          itemId: l.itemId ? Number(l.itemId) : null,
          accountId: l.accountId ? Number(l.accountId) : null,
          description: l.description,
          hsnSac: l.hsnSac,
          qty: l.qty,
          uqc: l.uqc,
          ratePaise: l.ratePaise,
          discountPct: l.discountPct,
          gstRatePct: l.gstRatePct,
          cessRatePct: l.cessRatePct,
          batch: l.batch?.batchNo ? l.batch : null,
          serials: l.serials,
          itcEligibility: l.itcEligibility,
        })),
      }),
    );

    await logAudit({
      orgId,
      actorUserId: user.userId,
      actorName: user.name,
      action: 'create',
      targetType: 'bill',
      targetId: created.id,
      targetLabel: created.internalNo,
      detail: `Recorded bill ${created.internalNo} (${input.vendorInvoiceNo})`,
      ...auditMeta(req),
    });

    return {
      id: asId(created.id),
      internalNo: created.internalNo,
      totalPaise: created.totalPaise,
      journalEntryId: created.journalEntryId ? asId(created.journalEntryId) : null,
      warnings: created.warnings,
    };
  },
  { permission: { module: 'purchases', action: 'create' } },
);
