import { db, transaction } from '@/lib/server/db';
import { route, body, idParam, badRequest, notFound } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deleteSalesDocument, updateSalesDocument, type EditableSalesDoc } from '@/lib/server/services/sales-documents';
import { CreateInput, toSalesDocInput } from '@/lib/server/sales-doc-input';

// Zoho Books' Edit and Delete on a quote, sales order, delivery challan or
// credit note (services/sales-documents.ts updateSalesDocument, deleteSalesDocument).

const KINDS: EditableSalesDoc[] = ['estimate', 'sales-order', 'challan', 'credit-note'];

function kindOf(params: Record<string, string | string[]> | undefined): EditableSalesDoc {
  const k = String(params?.kind ?? '');
  if (!KINDS.includes(k as EditableSalesDoc)) throw badRequest('That document cannot be edited here.');
  return k as EditableSalesDoc;
}

const TABLES = {
  estimate: { table: 'estimates', lines: 'estimate_lines', parent: 'estimate_id', date: 'estimate_date' },
  'sales-order': { table: 'sales_orders', lines: 'sales_order_lines', parent: 'sales_order_id', date: 'order_date' },
  challan: { table: 'delivery_challans', lines: 'challan_lines', parent: 'challan_id', date: 'challan_date' },
  'credit-note': { table: 'credit_notes', lines: 'credit_note_lines', parent: 'credit_note_id', date: 'note_date' },
} as const;

/** The document as saved, for its Edit dialog. */
export const GET = route(
  async ({ orgId, params }) => {
    const kind = kindOf(params);
    const id = idParam(params);
    const t = TABLES[kind];
    const row = await db.selectFrom(t.table).selectAll().where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst() as Record<string, unknown> | undefined;
    if (!row) throw notFound('That document does not exist.');
    const lines = await db.selectFrom(t.lines).selectAll().where(t.parent as never, '=', id as never).orderBy('line_no').execute() as Record<string, unknown>[];
    const day = (v: unknown) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);
    return {
      id: String(row.id), number: String(row.number), status: String(row.status), date: day(row[t.date]),
      branchId: String(row.branch_id), customerId: String(row.customer_id), placeOfSupply: (row.place_of_supply as string | null) ?? null,
      notes: (row.notes as string | null) ?? null,
      expiryDate: day(row.expiry_date), expectedShipDate: day(row.expected_ship_date),
      challanType: (row.challan_type as string | null) ?? null, reason: (row.reason as string | null) ?? null,
      againstInvoiceId: row.against_invoice_id ? String(row.against_invoice_id) : null,
      warehouseId: row.warehouse_id ? String(row.warehouse_id) : null,
      appliedPaise: row.applied_amount != null ? toPaiseFromSql(String(row.applied_amount)) : 0,
      lines: lines.map((l) => ({
        itemId: l.item_id ? String(l.item_id) : null, description: (l.description as string | null) ?? null, hsnSac: (l.hsn_sac as string | null) ?? null,
        qty: Number(l.qty), uqc: (l.uqc as string | null) ?? null, ratePaise: toPaiseFromSql(String(l.rate)),
        discountPct: Number(l.discount_pct ?? 0), gstRatePct: Number(l.gst_rate_pct ?? 0),
      })),
    };
  },
  { permission: { module: 'sales', action: 'view' } },
);

export const PUT = route(
  async ({ orgId, user, branchId, req, params }) => {
    const kind = kindOf(params);
    const id = idParam(params);
    const input = await body(req, CreateInput);
    if (input.kind !== kind) throw badRequest('A document keeps its kind when edited.');
    const done = await transaction(async (trx) => {
      const made = await updateSalesDocument(trx, orgId, user.userId, id, toSalesDocInput(input, Number(input.branchId ?? branchId) || branchId));
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: kind, targetId: id, targetLabel: made.number, detail: `Edited ${made.number}`,
        payload: { before: made.before }, ...auditMeta(req),
      });
      return made;
    });
    return { id: String(done.id), number: done.number, totalPaise: done.totalPaise };
  },
  { permission: { module: 'sales', action: 'edit' } },
);

export const DELETE = route(
  async ({ orgId, user, req, params }) => {
    const kind = kindOf(params);
    const id = idParam(params);
    const reason = new URL(req.url).searchParams.get('reason');
    const done = await transaction(async (trx) => {
      const gone = await deleteSalesDocument(trx, orgId, user.userId, kind, id, reason);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete',
        targetType: kind, targetId: id, targetLabel: gone.number, detail: `Deleted ${gone.number}`, ...auditMeta(req),
      });
      return gone;
    });
    return { deleted: true, number: done.number };
  },
  { permission: { module: 'sales', action: 'void' } },
);
