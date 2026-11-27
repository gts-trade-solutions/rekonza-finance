import { z } from 'zod';
import { sql } from 'kysely';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { createBill } from '@/lib/server/services/purchases';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { BillInput, toBillInput } from '@/lib/server/bill-input';

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

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, BillInput);

    const created = await transaction(async (trx) =>
      createBill(trx, orgId, user.userId, toBillInput(input)),
    );

    await logAudit({
      orgId,
      actorUserId: user.userId,
      actorName: user.name,
      action: 'create',
      targetType: 'bill',
      targetId: created.id,
      targetLabel: created.internalNo,
      // A bill saved although it looked like another keeps the reason given in the trail (services/bill-duplicates.ts).
      detail: `Recorded bill ${created.internalNo} (${input.vendorInvoiceNo})${input.duplicateReason ? `. Saved as not a duplicate: ${input.duplicateReason}` : ''}`,
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
