import { sql } from 'kysely';
import type { Executor } from '@/lib/server/db';
import { asId } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';

// ─────────────────────────────────────────────────────────────────────────────
// One item's place in the books: the documents it is on (Zoho's Transactions
// tab, "Filter By: Quotes ▾") and, before it may be deleted, everything that
// still refers to it.
// ─────────────────────────────────────────────────────────────────────────────

export type ItemTxKind =
  | 'estimate' | 'sales_order' | 'invoice' | 'debit_note' | 'challan' | 'credit_note' | 'recurring_invoice'
  | 'purchase_order' | 'bill';

export interface ItemTxRow {
  kind: ItemTxKind;
  /** The document's id; with `kind` it says which screen opens it. */
  id: string;
  date: string;
  number: string;
  party: string;
  qty: number;
  ratePaise: number;
  /** The line's value before GST, as Zoho's item total is. */
  amountPaise: number;
  status: string;
}

interface Spec {
  kind: ItemTxKind;
  side: 'sales' | 'purchases';
  lines: string;
  fk: string;
  docs: string;
  date: string;
  party: 'customer_id' | 'vendor_id';
  number?: ReturnType<typeof sql>;
  amount?: string;
  where?: ReturnType<typeof sql>;
}

const SPECS: Spec[] = [
  { kind: 'estimate', side: 'sales', lines: 'estimate_lines', fk: 'estimate_id', docs: 'estimates', date: 'estimate_date', party: 'customer_id' },
  { kind: 'sales_order', side: 'sales', lines: 'sales_order_lines', fk: 'sales_order_id', docs: 'sales_orders', date: 'order_date', party: 'customer_id' },
  { kind: 'invoice', side: 'sales', lines: 'invoice_lines', fk: 'invoice_id', docs: 'invoices', date: 'invoice_date', party: 'customer_id', where: sql`AND d.doc_kind = 'invoice'` },
  { kind: 'debit_note', side: 'sales', lines: 'invoice_lines', fk: 'invoice_id', docs: 'invoices', date: 'invoice_date', party: 'customer_id', where: sql`AND d.doc_kind = 'debit_note'` },
  // A challan carries no GST of its own: its lines' value is the line total.
  { kind: 'challan', side: 'sales', lines: 'challan_lines', fk: 'challan_id', docs: 'delivery_challans', date: 'challan_date', party: 'customer_id', amount: 'line_total' },
  { kind: 'credit_note', side: 'sales', lines: 'credit_note_lines', fk: 'credit_note_id', docs: 'credit_notes', date: 'note_date', party: 'customer_id' },
  { kind: 'purchase_order', side: 'purchases', lines: 'purchase_order_lines', fk: 'purchase_order_id', docs: 'purchase_orders', date: 'order_date', party: 'vendor_id' },
  // A bill is known by the vendor's own number; Rekonza's is the fallback.
  { kind: 'bill', side: 'purchases', lines: 'bill_lines', fk: 'bill_id', docs: 'bills', date: 'bill_date', party: 'vendor_id', number: sql`COALESCE(NULLIF(d.vendor_invoice_no, ''), d.internal_no)` },
];

/** How many of each kind are listed, newest first. */
const PER_KIND = 200;

/**
 * The documents an item is on, every kind at once: the tab switches between
 * them without asking again (and the online demo, which only replays what was
 * recorded, can switch too). Purchase documents only for those who may see
 * purchases.
 */
export async function itemTransactions(
  ex: Executor, orgId: number, itemId: number, sides: { sales: boolean; purchases: boolean },
): Promise<ItemTxRow[]> {
  const specs = SPECS.filter((s) => sides[s.side]);
  const sets = await Promise.all(specs.map(async (s) => {
    const { rows } = await sql<{ id: number; date: string; number: string; party: string | null; qty: string; rate: string; amount: string; status: string }>`
      SELECT d.id, d.${sql.ref(s.date)} AS date, ${s.number ?? sql`d.number`} AS number, c.display_name AS party,
             l.qty, l.rate, l.${sql.ref(s.amount ?? 'taxable')} AS amount, d.status
        FROM ${sql.table(s.lines)} l
        JOIN ${sql.table(s.docs)} d ON d.id = l.${sql.ref(s.fk)}
        LEFT JOIN contacts c ON c.id = d.${sql.ref(s.party)}
       WHERE d.org_id = ${orgId} AND l.item_id = ${itemId} ${s.where ?? sql``}
       ORDER BY d.${sql.ref(s.date)} DESC, d.id DESC
       LIMIT ${PER_KIND}`.execute(ex);
    return rows.map((r): ItemTxRow => ({
      kind: s.kind,
      id: asId(r.id),
      date: String(r.date).slice(0, 10),
      number: r.number,
      party: r.party ?? '',
      qty: Number(r.qty),
      ratePaise: toPaiseFromSql(r.rate),
      amountPaise: toPaiseFromSql(r.amount),
      status: r.status,
    }));
  }));

  // A recurring invoice keeps its lines on the profile, as JSON; the profiles
  // are few, so they are read and searched here.
  const recurring: ItemTxRow[] = [];
  if (sides.sales) {
    const profiles = await ex
      .selectFrom('recurring_invoices as r')
      .leftJoin('contacts as c', 'c.id', 'r.customer_id')
      .select(['r.id', 'r.profile_name', 'r.next_run', 'r.end_date', 'r.is_active', 'r.template', 'c.display_name'])
      .where('r.org_id', '=', orgId)
      .execute();
    const today = new Date().toISOString().slice(0, 10);
    for (const p of profiles) {
      const lines = (typeof p.template === 'string' ? JSON.parse(p.template) : p.template) as { itemId?: unknown; qty?: number; ratePaise?: number }[] | null;
      for (const l of Array.isArray(lines) ? lines : []) {
        if (l.itemId == null || String(l.itemId) !== String(itemId)) continue;
        const qty = Number(l.qty ?? 0);
        const rate = Math.round(Number(l.ratePaise ?? 0));
        const ended = p.end_date && String(p.end_date).slice(0, 10) < today;
        recurring.push({
          kind: 'recurring_invoice', id: asId(p.id), date: String(p.next_run).slice(0, 10), number: p.profile_name,
          party: p.display_name ?? '', qty, ratePaise: rate, amountPaise: Math.round(qty * rate),
          status: ended ? 'expired' : p.is_active ? 'active' : 'stopped',
        });
      }
    }
  }
  return [...sets.flat(), ...recurring];
}

export interface HsnChange { id: string; at: string; actor: string | null; itemId: string | null; item: string | null; from: string | null; to: string | null }

/**
 * Zoho's "HSN/SAC Update History": every change of an item's HSN or SAC code,
 * newest first, from the items' edit log (lib/server/audit.ts). The code an
 * item carries decides the GSTR-1 Table 12 line its sales are reported on, so
 * a changed code is worth seeing on its own.
 */
export async function hsnHistory(ex: Executor, orgId: number): Promise<HsnChange[]> {
  const rows = await ex.selectFrom('audit_log')
    .select(['id', 'created_at', 'actor_name', 'target_id', 'target_label',
      sql<string | null>`JSON_UNQUOTE(JSON_EXTRACT(payload, '$.changes.hsn_sac.from'))`.as('from_code'),
      sql<string | null>`JSON_UNQUOTE(JSON_EXTRACT(payload, '$.changes.hsn_sac.to'))`.as('to_code'),
    ])
    .where('org_id', '=', orgId)
    .where('target_type', '=', 'item')
    .where(sql<boolean>`JSON_EXTRACT(payload, '$.changes.hsn_sac') IS NOT NULL`)
    .orderBy('created_at', 'desc').orderBy('id', 'desc')
    .limit(300)
    .execute();
  const code = (v: string | null) => (v && v !== 'null' ? v : null);
  return rows.map((r) => ({
    id: asId(r.id), at: new Date(r.created_at).toISOString(), actor: r.actor_name,
    itemId: r.target_id, item: r.target_label, from: code(r.from_code), to: code(r.to_code),
  }));
}

/** What refers to an item, by table: each one blocks deleting it. */
const USES: { table: string; column: string; label: string }[] = [
  { table: 'invoice_lines', column: 'item_id', label: 'invoices' },
  { table: 'estimate_lines', column: 'item_id', label: 'quotes' },
  { table: 'sales_order_lines', column: 'item_id', label: 'sales orders' },
  { table: 'challan_lines', column: 'item_id', label: 'delivery challans' },
  { table: 'credit_note_lines', column: 'item_id', label: 'credit notes' },
  { table: 'purchase_order_lines', column: 'item_id', label: 'purchase orders' },
  { table: 'bill_lines', column: 'item_id', label: 'bills' },
  { table: 'goods_receipt_lines', column: 'item_id', label: 'goods receipts' },
  { table: 'stock_adjustments', column: 'item_id', label: 'stock adjustments' },
  { table: 'stock_transfer_lines', column: 'item_id', label: 'stock transfers' },
  { table: 'batches', column: 'item_id', label: 'batches' },
  { table: 'item_serials', column: 'item_id', label: 'serial numbers' },
  { table: 'boms', column: 'item_id', label: 'bills of materials' },
  { table: 'bom_lines', column: 'item_id', label: 'bills of materials (as a material)' },
  { table: 'productions', column: 'item_id', label: 'production runs' },
  { table: 'production_lines', column: 'item_id', label: 'production runs (as a material)' },
  { table: 'price_list_items', column: 'item_id', label: 'price lists' },
  { table: 'price_list_discounts', column: 'item_id', label: 'price list discounts' },
  { table: 'item_components', column: 'component_item_id', label: 'kits (as a component)' },
];

/**
 * Everything still referring to the item, as "3 invoices", "1 price lists"…;
 * empty when it is unused. The caller has already found the item in this
 * book: item ids are unique across books, and some line tables carry no book
 * of their own, so the counts go by the item alone.
 */
export async function itemUses(ex: Executor, orgId: number, itemId: number): Promise<string[]> {
  const counts = await Promise.all(USES.map(async (u) => {
    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*) AS n FROM ${sql.table(u.table)} WHERE ${sql.ref(u.column)} = ${itemId}`.execute(ex);
    return { label: u.label, n: Number(rows[0]?.n ?? 0) };
  }));
  const out = counts.filter((c) => c.n > 0).map((c) => `${c.n} ${c.label}`);

  // Recurring profiles keep their lines as JSON, out of reach of a foreign key.
  for (const table of ['recurring_invoices', 'recurring_purchases'] as const) {
    const rows = await ex.selectFrom(table).select('template').where('org_id', '=', orgId).execute();
    const n = rows.filter((r) => {
      const t = typeof r.template === 'string' ? JSON.parse(r.template) : r.template;
      return Array.isArray(t) && t.some((l: { itemId?: unknown }) => l?.itemId != null && String(l.itemId) === String(itemId));
    }).length;
    if (n) out.push(`${n} ${table === 'recurring_invoices' ? 'recurring invoices' : 'recurring bills'}`);
  }
  return out;
}
