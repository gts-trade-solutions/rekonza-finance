import { acceptQuote, cancelSalesOrderItems, openCreditNote, projectFromEstimate, purchaseOrderFromSalesOrder, retainerFromEstimate } from '@/lib/server/services/sales-extras';
import { z } from 'zod';
import { CreateInput, DATE, toNum, toSalesDocInput } from '@/lib/server/sales-doc-input';
import { sql } from 'kysely';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, badRequest } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { logAudit, auditMeta } from '@/lib/server/audit';
import {
  applyRetainer, convertToInvoice, createChallan, createCreditNote, createEstimate,
  createRetainer, createSalesOrder, refundCreditNote, applyCreditNote, salesOrderFromEstimate, voidCreditNote,
} from '@/lib/server/services/sales-documents';
import { challanFromSalesOrder, invoiceFromChallan, invoiceFromSalesOrder } from '@/lib/server/services/order-flow';
import { salesDocLinks } from '@/lib/server/services/sales-doc-links';
import { raiseProforma, setOrderStage, STAGE_LABEL } from '@/lib/server/services/order-stages';

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
      : q.kind === 'credit-note' ? sql`, NULL AS expiry, d.subtotal, d.reason AS converted_to_type, d.against_invoice_id AS converted_to_id, d.applied_amount AS applied, (SELECT i.number FROM invoices i WHERE i.id = d.against_invoice_id) AS linked_number`
      : sql`, NULL AS expiry, d.amount AS subtotal, d.description AS converted_to_type, d.project_id AS converted_to_id, d.applied_amount AS applied, (SELECT p.name FROM projects p WHERE p.id = d.project_id) AS linked_number`;

    const totalCol = q.kind === 'retainer' ? sql`d.amount` : sql`d.total`;
    // Zoho's Reference# column (migration 121; a retainer's, migration 122).
    const refCol = q.kind === 'retainer' ? sql`d.reference` : sql`d.reference_number`;
    // What the customer has actually settled. Only invoice-like documents have
    // one; a quote or a challan is nobody's debt.
    const paidCol =
      q.kind === 'retainer' ? sql`d.amount_paid`
      : sql`NULL`;

    const { rows } = await sql<{
      id: number; number: string; dt: string; status: string; customer_id: number;
      customer_name: string; total: string; subtotal: string; expiry: string | null;
      converted_to_type: string | null; converted_to_id: number | null;
      applied: string | null; paid: string | null; linked_number?: string | null;
      reference: string | null; created_at: Date | string | null;
    }>`
      SELECT d.id, d.number, ${dateCol} AS dt, d.status, d.customer_id, ${refCol} AS reference, d.created_at,
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

    const links = q.kind === 'challan' || q.kind === 'sales-order' ? await salesDocLinks(orgId, q.kind, rows.map((r) => r.id)) : null;

    return {
      kind: q.kind,
      documents: rows.map((r) => ({
        id: asId(r.id),
        number: r.number,
        reference: r.reference ?? null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
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
        // A credit note's invoice by its number, as the screen shows it.
        linkedNumber: r.linked_number ?? null,
        expiry: r.expiry ? String(r.expiry).slice(0, 10) : null,
        ...(links ? links.get(r.id) ?? {} : {}),
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

export const POST = route(
  async ({ orgId, user, branchId, req }) => {
    const input = await body(req, CreateInput);
    const branch = Number(input.branchId ?? branchId) || branchId;
    const customerId = Number(input.customerId);

    const created = await transaction(async (trx) => {
      if (input.kind !== 'retainer') {
        // One mapping for create and edit (lib/server/sales-doc-input.ts).
        const doc = toSalesDocInput(input, branch);
        switch (doc.kind) {
          case 'estimate': {
            const made = await createEstimate(trx, orgId, user.userId, doc.input);
            // "Create a retainer invoice for this quote automatically".
            if (doc.input.retainerPct) await retainerFromEstimate(trx, orgId, user.userId, made.id);
            return made;
          }
          case 'sales-order':
            return createSalesOrder(trx, orgId, user.userId, { ...doc.input, sourceEstimateId: input.kind === 'sales-order' ? toNum(input.sourceEstimateId) : null });
          case 'challan':
            return createChallan(trx, orgId, user.userId, doc.input);
          case 'credit-note':
            return createCreditNote(trx, orgId, user.userId, doc.input);
        }
      }
      switch (input.kind) {
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
  // Order → Proforma → Work in process → Ready for delivery (which invoices it).
  z.object({
    action: z.literal('stage'),
    id: z.union([z.string(), z.number()]),
    stage: z.enum(['order', 'proforma', 'in_process', 'ready']),
    date: DATE,
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
  // Zoho's "Apply to Invoices": what is left on a credit note, set against open invoices.
  z.object({
    action: z.literal('apply-credit-note'),
    id: z.union([z.string(), z.number()]),
    date: DATE,
    allocations: z.array(z.object({ invoiceId: z.union([z.string(), z.number()]).transform(Number), amountPaise: z.number().int().min(0) })).min(1).max(100),
  }),
  z.object({
    action: z.literal('set-status'),
    kind: z.enum(KINDS),
    id: z.union([z.string(), z.number()]),
    status: z.string(),
  }),
  // A draft credit note, posted (Zoho's "Convert to Open").
  z.object({ action: z.literal('open-credit-note'), id: z.union([z.string(), z.number()]) }),
  // Zoho's sales order "Cancel Items": omitted lines cancel everything left.
  z.object({ action: z.literal('cancel-items'), id: z.union([z.string(), z.number()]), lines: LINES }),
  // Zoho's sales order "Convert to Purchase Order".
  z.object({
    action: z.literal('to-purchase-order'),
    id: z.union([z.string(), z.number()]),
    vendorId: z.union([z.string(), z.number()]),
    date: DATE,
    expectedDate: DATE.nullish(),
    lineIds: z.array(z.union([z.string(), z.number()])).optional(),
  }),
  // Zoho's quote "Create Project".
  z.object({
    action: z.literal('create-project'),
    id: z.union([z.string(), z.number()]),
    name: z.string().trim().max(200).nullish(),
    billingMethod: z.enum(['fixed', 'project_hours', 'task_hours', 'staff_hours']).optional(),
    ratePaise: z.number().int().positive().optional(),
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

      case 'stage': {
        if (input.stage === 'proforma') {
          const pi = await transaction((trx) => raiseProforma(trx, orgId, id, input.date));
          await logAudit({
            orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
            targetType: 'sales_order', targetId: id, targetLabel: pi.number,
            detail: `Proforma invoice ${pi.number} for sales order #${id}`, ...auditMeta(req),
          });
          return { stage: pi.stage, proformaNumber: pi.number, proformaDate: pi.date };
        }
        const stage = input.stage;
        const done = await transaction((trx) => setOrderStage(trx, orgId, user.userId, id, stage, input.date));
        await logAudit({
          orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
          targetType: 'sales_order', targetId: id,
          detail: `Sales order #${id}: ${STAGE_LABEL[done.stage]}${done.ready?.invoice ? `, invoice ${done.ready.invoice.number}` : ''}${done.ready?.challan ? `, challan ${done.ready.challan.number}` : ''}`,
          ...auditMeta(req),
        });
        return {
          stage: done.stage,
          invoice: done.ready?.invoice ? { id: asId(done.ready.invoice.id), number: done.ready.invoice.number, heldForApproval: done.ready.invoice.heldForApproval } : null,
          challan: done.ready?.challan ? { id: asId(done.ready.challan.id), number: done.ready.challan.number } : null,
          closedChallans: (done.ready?.closedChallans ?? []).map((c) => ({ id: asId(c.id), number: c.number })),
          openChallans: done.ready?.openChallans ?? 0,
        };
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

      case 'apply-credit-note': {
        const r = await transaction(async (trx) => {
          const out = await applyCreditNote(trx, orgId, user.userId, id, { date: input.date, allocations: input.allocations });
          await logAudit({
            trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'credit-note', targetId: id,
            detail: `Applied ₹${(out.appliedPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} to ${input.allocations.filter((a) => a.amountPaise > 0).length} invoice(s)`,
            ...auditMeta(req),
          });
          return out;
        });
        return { appliedPaise: r.appliedPaise, status: r.status };
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

      case 'open-credit-note': {
        const made = await transaction(async (trx) => {
          const out = await openCreditNote(trx, orgId, user.userId, id);
          await logAudit({
            trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'credit-note', targetId: id,
            targetLabel: out.number, detail: `Draft credit note ${out.number} converted to open and posted`, ...auditMeta(req),
          });
          return out;
        });
        return { id: asId(made.id), number: made.number, status: 'open', journalEntryId: made.journalEntryId === null ? null : asId(made.journalEntryId) };
      }

      case 'cancel-items': {
        const out = await transaction(async (trx) => {
          const r = await cancelSalesOrderItems(trx, orgId, id, picks(input.lines));
          await logAudit({
            trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'sales-order', targetId: id,
            detail: `Cancelled ${r.cancelled} unit(s) still to invoice; the order is now ${r.status}`, ...auditMeta(req),
          });
          return r;
        });
        return out;
      }

      case 'to-purchase-order': {
        const out = await transaction(async (trx) => {
          const r = await purchaseOrderFromSalesOrder(trx, orgId, user.userId, id, {
            vendorId: Number(input.vendorId), date: input.date, expectedDate: input.expectedDate ?? null,
            lineIds: input.lineIds?.map(Number),
          });
          await logAudit({
            trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'purchase_order', targetId: r.id,
            targetLabel: r.number, detail: `Purchase order ${r.number} raised for sales order #${id}`, ...auditMeta(req),
          });
          return r;
        });
        return { purchaseOrderId: asId(out.id), number: out.number, totalPaise: out.totalPaise, skipped: out.skipped };
      }

      case 'create-project': {
        const out = await transaction(async (trx) => {
          const r = await projectFromEstimate(trx, orgId, user.userId, id, { name: input.name, billingMethod: input.billingMethod, ratePaise: input.ratePaise as never });
          await logAudit({
            trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'project', targetId: r.id,
            targetLabel: r.name, detail: `Project "${r.name}" made from quote #${id}`, ...auditMeta(req),
          });
          return r;
        });
        return { projectId: asId(out.id), name: out.name };
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
        // Accepting a quote does what Quote Preferences say: nothing more, or a draft invoice or a sales order.
        if (input.kind === 'estimate' && input.status === 'accepted') {
          const r = await transaction((trx) => acceptQuote(trx, orgId, user.userId, id, new Date().toISOString().slice(0, 10)));
          if (r.invoiceId || r.salesOrderId) {
            await logAudit({
              orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
              targetType: r.invoiceId ? 'invoice' : 'sales_order', targetId: (r.invoiceId ?? r.salesOrderId)!,
              targetLabel: r.invoiceNumber ?? r.salesOrderNumber, detail: `Made automatically when quote #${id} was accepted (Quote Preferences)`, ...auditMeta(req),
            });
          }
          return {
            id: asId(id), status: r.invoiceId || r.salesOrderId ? 'converted' : 'accepted',
            ...(r.invoiceId ? { invoiceId: asId(r.invoiceId), invoiceNumber: r.invoiceNumber } : {}),
            ...(r.salesOrderId ? { salesOrderId: asId(r.salesOrderId), salesOrderNumber: r.salesOrderNumber } : {}),
          };
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
