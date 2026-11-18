import { db } from '@/lib/server/db';
import { route, idParam, asId, notFound } from '@/lib/server/http';
import { canSeeCosts } from '@/lib/rbac';

// ─────────────────────────────────────────────────────────────────────────────
// An item's History tab: its own edit log (lib/server/audit.ts), newest first,
// each change spelt out the way a person reads it ("Selling Price ₹100.00 →
// ₹120.00") rather than as the column names the log keeps.
// ─────────────────────────────────────────────────────────────────────────────

const LABEL: Record<string, string> = {
  kind: 'Type', name: 'Name', sku: 'SKU', hsn_sac: 'HSN/SAC', uqc: 'Unit', description: 'Description',
  sale_price: 'Selling Price', purchase_price: 'Cost Price', mrp: 'MRP', standard_cost: 'Standard cost',
  gst_rate_pct: 'GST rate', tax_pref: 'Tax Preference', origin: 'Origin',
  track_inventory: 'Track inventory', track_batches: 'Track batches', track_serials: 'Track serial numbers',
  reorder_level: 'Reorder point', min_level: 'Minimum level',
  opening_stock_qty: 'Opening stock', opening_stock_rate: 'Opening stock rate',
  alt_uqc: 'Second unit', alt_factor: 'Units in the second unit',
  stock_group_id: 'Stock group', valuation_method: 'Valued by', is_archived: 'Status',
  item_type: 'Sold or bought', is_digital_service: 'Digital service', upc: 'UPC', ean: 'EAN', isbn: 'ISBN', mpn: 'MPN',
  purchase_description: 'Purchase Description', sale_account_id: 'Sales Account', purchase_account_id: 'Purchase Account',
  preferred_vendor_id: 'Preferred Vendor',
};
/** What goods cost: not shown to a role that may not see costs. */
const COST = new Set(['purchase_price', 'standard_cost', 'opening_stock_rate', 'purchase_account_id']);
const MONEY = new Set(['sale_price', 'purchase_price', 'mrp', 'standard_cost', 'opening_stock_rate']);
const YES_NO = new Set(['track_inventory', 'track_batches', 'track_serials', 'is_digital_service']);
const ITEM_TYPE: Record<string, string> = { sales: 'Sold only', purchases: 'Bought only', sales_and_purchases: 'Sold and bought' };
const TAX_PREF: Record<string, string> = { taxable: 'Taxable', exempt: 'Exempt', nil: 'Nil rated', non_gst: 'Non-GST supply' };

const truthy = (v: unknown) => v === true || v === 1 || v === '1';

function show(col: string, v: unknown, groups: Map<string, string>, names: Map<string, string>): string {
  if (v === null || v === undefined || v === '') return col === 'valuation_method' ? 'the book’s method' : '—';
  if (MONEY.has(col)) return `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (YES_NO.has(col)) return truthy(v) ? 'Yes' : 'No';
  if (col === 'is_archived') return truthy(v) ? 'Inactive' : 'Active';
  if (col === 'gst_rate_pct') return `${Number(v)}%`;
  if (col === 'tax_pref') return TAX_PREF[String(v)] ?? String(v);
  if (col === 'kind') return v === 'service' ? 'Service' : 'Goods';
  if (col === 'origin') return v === 'imported' ? 'Imported' : 'Local';
  if (col === 'valuation_method') return v === 'fifo' ? 'First in, first out' : 'Weighted average';
  if (col === 'stock_group_id') return groups.get(String(v)) ?? 'a group since removed';
  if (col === 'item_type') return ITEM_TYPE[String(v)] ?? String(v);
  if (col === 'sale_account_id' || col === 'purchase_account_id') return names.get(`a${v}`) ?? 'an account since removed';
  if (col === 'preferred_vendor_id') return names.get(`c${v}`) ?? 'a vendor since removed';
  if (/^-?\d+\.\d+$/.test(String(v))) return String(Number(v));
  return String(v);
}

export interface ItemHistoryEntry {
  id: string;
  at: string;
  actor: string | null;
  action: string;
  detail: string | null;
  changes: { field: string; from: string; to: string }[];
}

export const GET = route(
  async ({ orgId, role, params }) => {
    const id = idParam(params);
    const item = await db.selectFrom('items').select('id').where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
    if (!item) throw notFound('That item does not exist.');
    const seesCosts = canSeeCosts(role);

    const [rows, groupRows] = await Promise.all([
      db.selectFrom('audit_log')
        .select(['id', 'created_at', 'actor_name', 'action', 'detail', 'payload'])
        .where('org_id', '=', orgId).where('target_type', '=', 'item').where('target_id', '=', String(id))
        .orderBy('created_at', 'desc').orderBy('id', 'desc')
        .limit(200)
        .execute(),
      db.selectFrom('stock_groups').select(['id', 'name']).where('org_id', '=', orgId).execute(),
    ]);
    const groups = new Map(groupRows.map((g) => [String(g.id), g.name]));
    // The accounts and vendors the changes name, by id.
    const ids = { a: new Set<number>(), c: new Set<number>() };
    for (const r of rows) {
      const payload = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as { changes?: Record<string, { from: unknown; to: unknown }> } | null;
      for (const [col, c] of Object.entries(payload?.changes ?? {})) {
        const bucket = col === 'preferred_vendor_id' ? ids.c : col === 'sale_account_id' || col === 'purchase_account_id' ? ids.a : null;
        for (const v of [c.from, c.to]) if (bucket && v != null && v !== '') bucket.add(Number(v));
      }
    }
    const [accts, vendors] = await Promise.all([
      ids.a.size ? db.selectFrom('accounts').select(['id', 'name']).where('org_id', '=', orgId).where('id', 'in', [...ids.a]).execute() : [],
      ids.c.size ? db.selectFrom('contacts').select(['id', 'display_name']).where('org_id', '=', orgId).where('id', 'in', [...ids.c]).execute() : [],
    ]);
    const names = new Map<string, string>([
      ...accts.map((a) => [`a${a.id}`, a.name] as [string, string]),
      ...vendors.map((v) => [`c${v.id}`, v.display_name] as [string, string]),
    ]);

    const entries: ItemHistoryEntry[] = rows.map((r) => {
      const payload = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as { changes?: Record<string, { from: unknown; to: unknown }> } | null;
      const changes = Object.entries(payload?.changes ?? {}).map(([col, c]) => (
        !seesCosts && COST.has(col)
          ? { field: LABEL[col] ?? col, from: 'hidden', to: 'hidden' }
          : { field: LABEL[col] ?? col, from: show(col, c.from, groups, names), to: show(col, c.to, groups, names) }
      ));
      return {
        id: asId(r.id),
        at: new Date(r.created_at).toISOString(),
        actor: r.actor_name,
        action: r.action,
        // The one-line detail names raw columns; with the changes spelt out it is not needed.
        detail: changes.length ? null : r.detail,
        changes,
      };
    });
    return { entries };
  },
  { permission: { module: 'sales', action: 'view' } },
);
