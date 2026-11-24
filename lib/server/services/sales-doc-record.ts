import 'server-only';

// One quote, sales order, delivery challan or credit note, as its record (the
// split view beside the list) and its Edit form read it: the document as saved,
// and around it what Zoho's record shows — who raised it, the salesperson and
// project by name, what it became or came from, the invoices raised from it,
// and for a credit note what is left of it to apply or refund.

import { sql } from 'kysely';
import { db, type Executor } from '../db';
import { notFound } from '../http';
import { toPaiseFromSql } from '../money-sql';
import { salesDocLinks } from './sales-doc-links';
import type { EditableSalesDoc } from './sales-documents';

const TABLES = {
  estimate: { table: 'estimates', lines: 'estimate_lines', parent: 'estimate_id', date: 'estimate_date' },
  'sales-order': { table: 'sales_orders', lines: 'sales_order_lines', parent: 'sales_order_id', date: 'order_date' },
  challan: { table: 'delivery_challans', lines: 'challan_lines', parent: 'challan_id', date: 'challan_date' },
  'credit-note': { table: 'credit_notes', lines: 'credit_note_lines', parent: 'credit_note_id', date: 'note_date' },
} as const;

type Row = Record<string, unknown>;
const day = (v: unknown) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);
const str = (v: unknown) => (v == null || v === '' ? null : String(v));
const paise = (v: unknown) => (v == null ? 0 : toPaiseFromSql(String(v)));
const ref = (id: unknown, number: unknown) => (id ? { id: String(id), number: String(number ?? '') } : null);

async function nameOf(ex: Executor, table: 'users' | 'projects' | 'contacts', id: unknown, orgId: number): Promise<string | null> {
  if (!id) return null;
  const col = table === 'contacts' ? 'display_name' : 'name';
  const r = await ex.selectFrom(table).select(`${col} as n` as never).where('id', '=', Number(id)).where('org_id', '=', orgId).executeTakeFirst() as { n?: string } | undefined;
  return r?.n ?? null;
}

export async function salesDocRecord(orgId: number, kind: EditableSalesDoc, id: number, ex: Executor = db) {
  const t = TABLES[kind];
  const row = await ex.selectFrom(t.table).selectAll().where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst() as Row | undefined;
  if (!row) throw notFound('That document does not exist.');
  // The line table is chosen at run time; its name and column come from the map above, never the request.
  const { rows: lines } = await sql<Row>`
    SELECT l.*, i.name AS item_name, i.sku AS item_sku
      FROM ${sql.raw(t.lines)} l LEFT JOIN items i ON i.id = l.item_id
     WHERE l.${sql.raw(t.parent)} = ${id} AND l.org_id = ${orgId}
     ORDER BY l.line_no`.execute(ex);

  const [customerName, salespersonName, projectName, createdByName] = await Promise.all([
    nameOf(ex, 'contacts', row.customer_id, orgId),
    nameOf(ex, 'users', row.salesperson_id, orgId),
    nameOf(ex, 'projects', row.project_id, orgId),
    nameOf(ex, 'users', row.created_by_user_id, orgId),
  ]);

  // What it became, what it came from, and the invoices raised from it.
  let convertedTo: { type: string; id: string; number: string } | null = null;
  let sourceEstimate: { id: string; number: string } | null = null;
  let salesOrder: { id: string; number: string } | null = null;
  let againstInvoice: { id: string; number: string } | null = null;
  let invoices: { id: string; number: string }[] = [];
  let challans: { id: string; number: string }[] = [];
  if (kind === 'estimate' && row.converted_to_id) {
    const type = String(row.converted_to_type ?? '');
    const target = type === 'sales_order'
      ? await ex.selectFrom('sales_orders').select('number').where('id', '=', Number(row.converted_to_id)).where('org_id', '=', orgId).executeTakeFirst()
      : await ex.selectFrom('invoices').select('number').where('id', '=', Number(row.converted_to_id)).where('org_id', '=', orgId).executeTakeFirst();
    if (target) convertedTo = { type: type || 'invoice', id: String(row.converted_to_id), number: target.number };
  }
  if (kind === 'sales-order') {
    if (row.source_estimate_id) {
      const e = await ex.selectFrom('estimates').select('number').where('id', '=', Number(row.source_estimate_id)).where('org_id', '=', orgId).executeTakeFirst();
      sourceEstimate = ref(row.source_estimate_id, e?.number);
    }
    invoices = (await salesDocLinks(orgId, 'sales-order', [id], ex)).get(id)?.invoices ?? [];
    challans = (await ex.selectFrom('delivery_challans').select(['id', 'number']).where('org_id', '=', orgId).where('source_so_id', '=', id).orderBy('id').execute())
      .map((c) => ({ id: String(c.id), number: c.number }));
  }
  if (kind === 'challan') {
    const l = (await salesDocLinks(orgId, 'challan', [id], ex)).get(id);
    invoices = l?.invoices ?? [];
    salesOrder = l?.salesOrder ?? null;
  }
  // A sales order's purchase orders (Zoho's Convert to Purchase Order), a quote's automatic retainer.
  let purchaseOrders: { id: string; number: string }[] = [];
  let retainers: { id: string; number: string }[] = [];
  if (kind === 'sales-order') {
    purchaseOrders = (await ex.selectFrom('purchase_orders').select(['id', 'number']).where('org_id', '=', orgId).where('source_sales_order_id', '=', id).orderBy('id').execute())
      .map((p) => ({ id: String(p.id), number: p.number }));
  }
  if (kind === 'estimate') {
    retainers = (await ex.selectFrom('retainer_invoices').select(['id', 'number']).where('org_id', '=', orgId).where('source_estimate_id', '=', id).orderBy('id').execute())
      .map((r) => ({ id: String(r.id), number: r.number }));
  }
  if (kind === 'credit-note' && row.against_invoice_id) {
    const inv = await ex.selectFrom('invoices').select(['number', 'invoice_date']).where('id', '=', Number(row.against_invoice_id)).where('org_id', '=', orgId).executeTakeFirst();
    againstInvoice = ref(row.against_invoice_id, inv?.number);
  }

  const totalPaise = paise(row.total);
  const appliedPaise = row.applied_amount != null ? paise(row.applied_amount) : 0;
  return {
    kind,
    id: String(row.id), number: String(row.number), status: String(row.status), date: day(row[t.date]),
    branchId: String(row.branch_id), customerId: String(row.customer_id), customerName,
    placeOfSupply: str(row.place_of_supply), supplyType: str(row.supply_type),
    notes: str(row.notes), terms: str(row.terms), referenceNumber: str(row.reference_number),
    salespersonId: str(row.salesperson_id), salespersonName,
    projectId: str(row.project_id), projectName,
    paymentTerms: str(row.payment_terms), deliveryMethod: str(row.delivery_method),
    expiryDate: day(row.expiry_date), expectedShipDate: day(row.expected_ship_date),
    challanType: str(row.challan_type), reason: str(row.reason),
    againstInvoiceId: row.against_invoice_id ? String(row.against_invoice_id) : null,
    warehouseId: row.warehouse_id ? String(row.warehouse_id) : null,
    stage: str(row.stage), proformaNumber: str(row.proforma_number),
    subtotalPaise: row.subtotal != null ? paise(row.subtotal) : totalPaise,
    cgstPaise: paise(row.cgst), sgstPaise: paise(row.sgst), igstPaise: paise(row.igst), cessPaise: paise(row.cess),
    totalPaise,
    appliedPaise,
    invoicedPaise: row.invoiced_amount != null ? paise(row.invoiced_amount) : 0,
    /** A credit note's: what is left to apply or refund. */
    balancePaise: kind === 'credit-note' ? Math.max(0, totalPaise - appliedPaise) : null,
    journalEntryId: row.journal_entry_id ? String(row.journal_entry_id) : null,
    createdAt: row.created_at ? new Date(row.created_at as string).toISOString() : null,
    createdByName,
    convertedTo, sourceEstimate, salesOrder, againstInvoice, invoices, challans, purchaseOrders, retainers,
    /** Zoho's Shipping Charges and Adjustment (migration 124). */
    shippingChargePaise: row.shipping_charge != null ? paise(row.shipping_charge) : 0,
    adjustmentPaise: row.adjustment != null ? paise(row.adjustment) : 0,
    adjustmentLabel: str(row.adjustment_label),
    /** Reverse charge: the buyer pays the GST (quotes and orders). */
    reverseCharge: Number(row.reverse_charge ?? 0) === 1,
    retainerPct: row.retainer_pct != null ? Number(row.retainer_pct) : null,
    lines: lines.map((l) => ({
      lineId: String(l.id),
      accountId: l.account_id ? String(l.account_id) : null,
      qtyInvoiced: l.qty_invoiced != null ? Number(l.qty_invoiced) : 0,
      qtyDelivered: l.qty_delivered != null ? Number(l.qty_delivered) : 0,
      qtyCancelled: l.qty_cancelled != null ? Number(l.qty_cancelled) : 0,
      itemId: l.item_id ? String(l.item_id) : null, itemName: str(l.item_name), sku: str(l.item_sku),
      description: str(l.description), hsnSac: str(l.hsn_sac),
      qty: Number(l.qty), uqc: str(l.uqc), ratePaise: paise(l.rate),
      discountPct: Number(l.discount_pct ?? 0), gstRatePct: Number(l.gst_rate_pct ?? 0),
      amountPaise: l.taxable != null ? paise(l.taxable) : paise(l.line_total),
    })),
  };
}

export type SalesDocRecord = Awaited<ReturnType<typeof salesDocRecord>>;
