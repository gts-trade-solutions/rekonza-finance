import { z } from 'zod';
import { sql } from 'kysely';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, badRequest } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { logAudit, auditMeta } from '@/lib/server/audit';
import {
  applyRetainer, convertToInvoice, createChallan, createCreditNote, createEstimate,
  createRetainer, createSalesOrder, refundCreditNote, salesOrderFromEstimate, voidCreditNote,
} from '@/lib/server/services/sales-documents';
import { challanFromSalesOrder, invoiceFromChallan, invoiceFromSalesOrder } from '@/lib/server/services/order-flow';

// ─────────────────────────────────────────────────────────────────────────────
// One endpoint for the five documents that surround an invoice.
//
// They share a customer, a period, a line shape and a list screen. Five route
// files would be five copies of the same parsing and the same permission check,
// differing only in a table name.
// ─────────────────────────────────────────────────────────────────────────────

const KINDS = ['estimate', 'sales-order', 'challan', 'credit-note', 'retainer'] as const;
type Kind = (typeof KINDS)[number];

const ListQuery = z.object({
  kind: z.enum(KINDS),
  from: z.string().optional(),
  to: z.string().optional(),
  status: z.string().optional(),
  customerId: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

interface TableSpec {
  table: 'estimates' | 'sales_orders' | 'delivery_challans' | 'credit_notes' | 'retainer_invoices';
  dateCol: string;
  numberCol: string;
}

const SPEC: Record<Kind, TableSpec> = {
  estimate: { table: 'estimates', dateCol: 'estimate_date', numberCol: 'number' },
  'sales-order': { table: 'sales_orders', dateCol: 'order_date', numberCol: 'number' },
  challan: { table: 'delivery_challans', dateCol: 'challan_date', numberCol: 'number' },
  'credit-note': { table: 'credit_notes', dateCol: 'note_date', numberCol: 'number' },
  retainer: { table: 'retainer_invoices', dateCol: 'retainer_date', numberCol: 'number' },
};

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, ListQuery);
    const spec = SPEC[q.kind];

    // Kysely cannot type a table chosen at runtime, so the list query is built
    // as SQL. Every interpolation is a bound parameter; the only thing spliced
    // literally is a table and column name taken from the map above, never
    // from the request.
    const t = sql.raw(spec.table);
    const dateCol = sql.raw(`d.${spec.dateCol}`);

    const where: ReturnType<typeof sql>[] = [sql`d.org_id = ${orgId}`];
    if (q.from) where.push(sql`${dateCol} >= ${q.from}`);
    if (q.to) where.push(sql`${dateCol} <= ${q.to}`);
    if (q.status && q.status !== 'all') where.push(sql`d.status = ${q.status}`);
    if (q.customerId) where.push(sql`d.customer_id = ${Number(q.customerId)}`);
    if (q.search) {
      const term = `%${q.search}%`;
      where.push(sql`(d.number LIKE ${term} OR c.display_name LIKE ${term})`);
    }
    const clause = sql.join(where, sql` AND `);

    const extra =
      q.kind === 'estimate' ? sql`, d.expiry_date AS expiry, d.subtotal, d.converted_to_type, d.converted_to_id, NULL AS applied`
      : q.kind === 'sales-order' ? sql`, d.expected_ship_date AS expiry, d.subtotal, NULL AS converted_to_type, NULL AS converted_to_id, d.invoiced_amount AS applied`
      : q.kind === 'challan' ? sql`, NULL AS expiry, d.total AS subtotal, d.challan_type AS converted_to_type, NULL AS converted_to_id, NULL AS applied`
      : q.kind === 'credit-note' ? sql`, NULL AS expiry, d.subtotal, d.reason AS converted_to_type, d.against_invoice_id AS converted_to_id, d.applied_amount AS applied`
      : sql`, NULL AS expiry, d.amount AS subtotal, d.description AS converted_to_type, NULL AS converted_to_id, d.applied_amount AS applied`;

    const totalCol = q.kind === 'retainer' ? sql`d.amount` : sql`d.total`;
    // What the customer has actually settled. Only invoice-like documents have
    // one; a quote or a challan is nobody's debt.
    const paidCol =
      q.kind === 'retainer' ? sql`d.amount_paid`
      : sql`NULL`;

    const { rows } = await sql<{
      id: number; number: string; dt: string; status: string; customer_id: number;
      customer_name: string; total: string; subtotal: string; expiry: string | null;
      converted_to_type: string | null; converted_to_id: number | null;
      applied: string | null; paid: string | null;
    }>`
      SELECT d.id, d.number, ${dateCol} AS dt, d.status, d.customer_id,
             c.display_name AS customer_name, ${totalCol} AS total, ${paidCol} AS paid ${extra}
        FROM ${t} d
        JOIN contacts c ON c.id = d.customer_id
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
        customerId: asId(r.customer_id),
        customerName: r.customer_name,
        subtotalPaise: toPaiseFromSql(r.subtotal),
        totalPaise: toPaiseFromSql(r.total),
        appliedPaise: r.applied === null ? null : toPaiseFromSql(r.applied),
        paidPaise: r.paid === null ? null : toPaiseFromSql(r.paid),
        // Whatever second string this document type carries: an expiry, a ship
        // date, a reason, a description.
        detail: r.converted_to_type,
        linkedId: r.converted_to_id === null ? null : asId(r.converted_to_id),
        expiry: r.expiry ? String(r.expiry).slice(0, 10) : null,
      })),
      statusCounts,
      summary: {
        count: rows.length,
        totalPaise: rows.reduce((t2, r) => t2 + toPaiseFromSql(r.total), 0),
        openPaise: rows
          .filter((r) => r.status !== 'void' && r.status !== 'cancelled' && r.status !== 'converted')
          .reduce((t2, r) => t2 + toPaiseFromSql(r.total), 0),
      },
    };
  },
  { permission: { module: 'sales', action: 'view' } },
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
  /** A serial-tracked item coming back on a credit note: the number of each piece. */
  serials: z.array(z.string().trim().min(1).max(80)).max(5000).nullish(),
});

const toNum = (v: string | number | null | undefined) => (v == null ? null : Number(v));
const mapLines = (lines: z.infer<typeof LineInput>[]) =>
  lines.map((l) => ({ ...l, itemId: toNum(l.itemId) }));

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Give the date as yyyy-mm-dd.');

const CreateInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('estimate'),
    branchId: z.union([z.string(), z.number()]),
    customerId: z.union([z.string(), z.number()]),
    date: DATE,
    expiryDate: DATE,
    lines: z.array(LineInput).min(1),
    placeOfSupply: z.string().length(2).optional(),
    notes: z.string().nullish(),
    status: z.enum(['draft', 'sent']).optional(),
    voucherTypeId: z.union([z.string(), z.number()]).nullish(),
  }),
  z.object({
    kind: z.literal('sales-order'),
    branchId: z.union([z.string(), z.number()]),
    customerId: z.union([z.string(), z.number()]),
    date: DATE,
    expectedShipDate: DATE.nullish(),
    lines: z.array(LineInput).min(1),
    placeOfSupply: z.string().length(2).optional(),
    notes: z.string().nullish(),
    sourceEstimateId: z.union([z.string(), z.number()]).nullish(),
    voucherTypeId: z.union([z.string(), z.number()]).nullish(),
  }),
  z.object({
    kind: z.literal('challan'),
    branchId: z.union([z.string(), z.number()]),
    customerId: z.union([z.string(), z.number()]),
    date: DATE,
    challanType: z.enum(['job_work', 'supply_on_approval', 'liquid_gas', 'other']).optional(),
    lines: z.array(LineInput).min(1),
    placeOfSupply: z.string().length(2).optional(),
    notes: z.string().nullish(),
    voucherTypeId: z.union([z.string(), z.number()]).nullish(),
  }),
  z.object({
    kind: z.literal('credit-note'),
    branchId: z.union([z.string(), z.number()]),
    customerId: z.union([z.string(), z.number()]),
    date: DATE,
    reason: z.string().trim().min(1, 'GST requires a reason on every credit note.').max(200),
    againstInvoiceId: z.union([z.string(), z.number()]).nullish(),
    applyImmediately: z.boolean().optional(),
    warehouseId: z.union([z.string(), z.number()]).nullish(),
    lines: z.array(LineInput).min(1),
    placeOfSupply: z.string().length(2).optional(),
    notes: z.string().nullish(),
    voucherTypeId: z.union([z.string(), z.number()]).nullish(),
  }),
  z.object({
    kind: z.literal('retainer'),
    branchId: z.union([z.string(), z.number()]),
    customerId: z.union([z.string(), z.number()]),
    date: DATE,
    description: z.string().trim().min(1, 'Say what the retainer covers.').max(500),
    amountPaise: z.number().int().positive(),
    status: z.enum(['draft', 'sent']).optional(),
  }),
]);

export const POST = route(
  async ({ orgId, user, branchId, req }) => {
    const input = await body(req, CreateInput);
    const branch = Number(input.branchId ?? branchId) || branchId;
    const customerId = Number(input.customerId);

    const created = await transaction(async (trx) => {
      switch (input.kind) {
        case 'estimate':
          return createEstimate(trx, orgId, user.userId, {
            branchId: branch, customerId, date: input.date, expiryDate: input.expiryDate,
            lines: mapLines(input.lines), placeOfSupply: input.placeOfSupply,
            notes: input.notes, status: input.status, voucherTypeId: toNum(input.voucherTypeId),
          });
        case 'sales-order':
          return createSalesOrder(trx, orgId, user.userId, {
            branchId: branch, customerId, date: input.date,
            expectedShipDate: input.expectedShipDate ?? null,
            lines: mapLines(input.lines), placeOfSupply: input.placeOfSupply,
            notes: input.notes, sourceEstimateId: toNum(input.sourceEstimateId), voucherTypeId: toNum(input.voucherTypeId),
          });
        case 'challan':
          return createChallan(trx, orgId, user.userId, {
            branchId: branch, customerId, date: input.date, challanType: input.challanType,
            lines: mapLines(input.lines), placeOfSupply: input.placeOfSupply, notes: input.notes, voucherTypeId: toNum(input.voucherTypeId),
          });
        case 'credit-note':
          return createCreditNote(trx, orgId, user.userId, {
            branchId: branch, customerId, date: input.date, reason: input.reason,
            againstInvoiceId: toNum(input.againstInvoiceId),
            applyImmediately: input.applyImmediately,
            warehouseId: toNum(input.warehouseId),
            lines: mapLines(input.lines), placeOfSupply: input.placeOfSupply, notes: input.notes, voucherTypeId: toNum(input.voucherTypeId),
          });
        case 'retainer':
          return createRetainer(trx, orgId, user.userId, {
            branchId: branch, customerId, date: input.date,
            description: input.description, amountPaise: input.amountPaise, status: input.status,
          });
      }
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
  { permission: { module: 'sales', action: 'create' } },
);

/** Which lines go on, and how much of each; omitted, everything left. */
const LINES = z.array(z.object({ lineId: z.union([z.string(), z.number()]), qty: z.number().positive() })).optional();
const picks = (lines: z.infer<typeof LINES>) => lines?.map((l) => ({ lineId: Number(l.lineId), qty: l.qty }));

const ActionInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('convert'),
    kind: z.enum(['estimate', 'sales-order', 'challan']),
    id: z.union([z.string(), z.number()]),
    date: DATE,
    dueDate: DATE,
    status: z.enum(['draft', 'approved']).optional(),
    lines: LINES,
  }),
  // Quotation → Sales Order.
  z.object({
    action: z.literal('to-order'),
    id: z.union([z.string(), z.number()]),
    date: DATE,
    expectedShipDate: DATE.nullish(),
  }),
  z.object({
    action: z.literal('deliver'),
    id: z.union([z.string(), z.number()]),
    date: DATE,
    challanType: z.enum(['supply_on_approval', 'liquid_gas', 'other']).optional(),
    notes: z.string().nullish(),
    lines: LINES,
  }),
  z.object({
    action: z.literal('apply-retainer'),
    id: z.union([z.string(), z.number()]),
    invoiceId: z.union([z.string(), z.number()]),
    amountPaise: z.number().int().positive().optional(),
  }),
  z.object({
    action: z.literal('refund-credit-note'),
    id: z.union([z.string(), z.number()]),
    bankAccountId: z.union([z.string(), z.number()]),
    date: DATE,
    amountPaise: z.number().int().positive().optional(),
    reference: z.string().nullish(),
  }),
  z.object({
    action: z.literal('void-credit-note'),
    id: z.union([z.string(), z.number()]),
    reason: z.string().nullish(),
  }),
  z.object({
    action: z.literal('set-status'),
    kind: z.enum(KINDS),
    id: z.union([z.string(), z.number()]),
    status: z.string(),
  }),
]);

export const PATCH = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, ActionInput);
    const id = Number(input.id);

    switch (input.action) {
      case 'convert': {
        const opts = { date: input.date, dueDate: input.dueDate, status: input.status, lines: picks(input.lines) };
        const created = await transaction((trx) =>
          input.kind === 'challan'
            ? invoiceFromChallan(trx, orgId, user.userId, id, opts)
            : input.kind === 'sales-order'
              ? invoiceFromSalesOrder(trx, orgId, user.userId, id, opts)
              : convertToInvoice(trx, orgId, user.userId, { type: 'estimate', id }, opts),
        );
        await logAudit({
          orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
          targetType: 'invoice', targetId: created.id, targetLabel: created.number,
          detail: `Converted ${input.kind} #${id} to invoice ${created.number}`, ...auditMeta(req),
        });
        return {
          invoiceId: asId(created.id), number: created.number, totalPaise: created.totalPaise,
          heldForApproval: !!created.heldForApproval,
        };
      }

      case 'to-order': {
        const created = await transaction((trx) =>
          salesOrderFromEstimate(trx, orgId, user.userId, id, { date: input.date, expectedShipDate: input.expectedShipDate }));
        await logAudit({
          orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
          targetType: 'sales_order', targetId: created.id, targetLabel: created.number,
          detail: `Sales order ${created.number} from estimate #${id}`, ...auditMeta(req),
        });
        return { salesOrderId: asId(created.id), number: created.number, totalPaise: created.totalPaise };
      }

      case 'deliver': {
        const created = await transaction((trx) =>
          challanFromSalesOrder(trx, orgId, user.userId, id, {
            date: input.date, challanType: input.challanType, notes: input.notes, lines: picks(input.lines),
          }),
        );
        await logAudit({
          orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
          targetType: 'challan', targetId: created.id, targetLabel: created.number,
          detail: `Delivery challan ${created.number} against sales order #${id}`, ...auditMeta(req),
        });
        return { challanId: asId(created.id), number: created.number };
      }

      case 'apply-retainer': {
        const r = await transaction((trx) =>
          applyRetainer(trx, orgId, user.userId, id, Number(input.invoiceId), input.amountPaise),
        );
        return { appliedPaise: r.appliedPaise, journalEntryId: asId(r.journalEntryId) };
      }

      case 'refund-credit-note': {
        const r = await transaction((trx) =>
          refundCreditNote(trx, orgId, user.userId, id, {
            bankAccountId: Number(input.bankAccountId),
            date: input.date,
            amountPaise: input.amountPaise,
            reference: input.reference ?? null,
          }),
        );
        return { refundedPaise: r.refundedPaise, journalEntryId: asId(r.journalEntryId) };
      }

      case 'void-credit-note': {
        await transaction((trx) => voidCreditNote(trx, orgId, user.userId, id, input.reason ?? undefined));
        await logAudit({
          orgId, actorUserId: user.userId, actorName: user.name, action: 'void',
          targetType: 'credit-note', targetId: id, detail: input.reason ?? 'Credit note voided',
          ...auditMeta(req),
        });
        return { id: asId(id), status: 'void' };
      }

      case 'set-status': {
        // Only the statuses a person legitimately sets by hand. Anything that
        // follows from a posting — converted, applied, invoiced — is set by the
        // service that did the posting, never by a request.
        const ALLOWED: Record<Kind, string[]> = {
          estimate: ['draft', 'sent', 'accepted', 'declined', 'expired'],
          'sales-order': ['open', 'closed', 'cancelled'],
          challan: ['open', 'returned', 'cancelled'],
          'credit-note': [],
          retainer: ['draft', 'sent'],
        };
        if (!ALLOWED[input.kind].includes(input.status)) {
          throw badRequest(
            `A ${input.kind.replace('-', ' ')} cannot be moved to "${input.status}" by hand.`,
          );
        }
        const spec = SPEC[input.kind];
        await sql`
          UPDATE ${sql.raw(spec.table)} SET status = ${input.status}
           WHERE id = ${id} AND org_id = ${orgId}
        `.execute(db);
        return { id: asId(id), status: input.status };
      }
    }
  },
  { permission: { module: 'sales', action: 'edit' } },
);
