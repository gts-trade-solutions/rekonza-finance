import { sql } from 'kysely';
import { db, type Executor } from '@/lib/server/db';
import { asId } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';

// ─────────────────────────────────────────────────────────────────────────────
// An item as the screens read it: the list (GET /api/items) and one item's own
// page (GET /api/items/[id]) shape it the same way, so the column on the left
// of Zoho's split view and the record beside it can never disagree.
// ─────────────────────────────────────────────────────────────────────────────

/** The item columns every screen reads. */
export function selectItems(orgId: number, ex: Executor = db) {
  return ex
    .selectFrom('items')
    .where('org_id', '=', orgId)
    .select([
      'id', 'kind', 'name', 'sku', 'hsn_sac', 'uqc', 'sale_price', 'purchase_price',
      'gst_rate_pct', 'tax_pref', 'description', 'track_inventory', 'track_batches', 'reorder_level',
      'opening_stock_qty', 'opening_stock_rate', 'is_archived',
      'mrp', 'standard_cost', 'alt_uqc', 'alt_factor', 'min_level', 'track_serials', 'updated_at', 'created_at',
      'stock_group_id', 'valuation_method', 'is_kit', 'item_group_id', 'variant',
      'image_file_id', 'origin',
      'item_type', 'is_digital_service', 'upc', 'ean', 'isbn', 'mpn', 'purchase_description',
      'sale_account_id', 'purchase_account_id', 'preferred_vendor_id', 'created_source',
    ]);
}

export type ItemDbRow = Awaited<ReturnType<ReturnType<typeof selectItems>['execute']>>[number];

/**
 * The rows as the API returns them, with each item's kit components and how
 * much of it has actually sold. The sales figures come from the invoice lines
 * rather than a stored counter: a counter is one more thing that can drift.
 */
export async function shapeItems(orgId: number, rows: ItemDbRow[], ex: Executor = db) {
  const ids = rows.map((r) => r.id);
  const [comps, sold] = ids.length
    ? await Promise.all([
        ex.selectFrom('item_components').select(['kit_item_id', 'component_item_id', 'qty'])
          .where('org_id', '=', orgId).where('kit_item_id', 'in', ids).execute(),
        ex.selectFrom('invoice_lines')
          .innerJoin('invoices', 'invoices.id', 'invoice_lines.invoice_id')
          .select([
            'invoice_lines.item_id as id',
            sql<string>`COALESCE(SUM(invoice_lines.qty), 0)`.as('qty'),
            sql<string>`COALESCE(SUM(invoice_lines.taxable), 0)`.as('value'),
          ])
          .where('invoices.org_id', '=', orgId)
          .where('invoice_lines.item_id', 'in', ids)
          .where('invoices.status', 'not in', ['draft', 'void'])
          .groupBy('invoice_lines.item_id')
          .execute(),
      ])
    : [[], []];
  const soldBy = new Map(sold.map((s) => [s.id, s]));

  return rows.map((i) => ({
    id: asId(i.id),
    kind: i.kind,
    name: i.name,
    sku: i.sku,
    hsnSac: i.hsn_sac,
    uqc: i.uqc,
    salePricePaise: toPaiseFromSql(i.sale_price),
    purchasePricePaise: toPaiseFromSql(i.purchase_price),
    gstRatePct: Number(i.gst_rate_pct),
    taxPref: i.tax_pref,
    description: i.description,
    origin: i.origin,
    trackInventory: !!i.track_inventory,
    trackBatches: !!i.track_batches,
    reorderLevel: i.reorder_level === null ? null : Number(i.reorder_level),
    openingStockQty: i.opening_stock_qty === null ? null : Number(i.opening_stock_qty),
    openingStockRatePaise: i.opening_stock_rate === null ? null : toPaiseFromSql(i.opening_stock_rate),
    isArchived: !!i.is_archived,
    mrpPaise: i.mrp === null ? null : toPaiseFromSql(i.mrp),
    standardCostPaise: i.standard_cost === null ? null : toPaiseFromSql(i.standard_cost),
    altUqc: i.alt_uqc,
    altFactor: i.alt_factor === null ? null : Number(i.alt_factor),
    minLevel: i.min_level === null ? null : Number(i.min_level),
    trackSerials: !!i.track_serials,
    stockGroupId: i.stock_group_id ? asId(i.stock_group_id) : null,
    valuationMethod: i.valuation_method,
    isKit: !!i.is_kit,
    imageFileId: i.image_file_id ? asId(i.image_file_id) : null,
    kitComponents: comps.filter((c) => c.kit_item_id === i.id).map((c) => ({ itemId: asId(c.component_item_id), qty: Number(c.qty) })),
    itemGroupId: i.item_group_id ? asId(i.item_group_id) : null,
    variant: i.variant ? (typeof i.variant === 'string' ? JSON.parse(i.variant) : i.variant) as Record<string, string> : null,
    updatedAt: new Date(i.updated_at).toISOString(),
    createdAt: new Date(i.created_at).toISOString(),
    itemType: i.item_type,
    isDigitalService: !!i.is_digital_service,
    upc: i.upc,
    ean: i.ean,
    isbn: i.isbn,
    mpn: i.mpn,
    purchaseDescription: i.purchase_description,
    saleAccountId: i.sale_account_id ? asId(i.sale_account_id) : null,
    purchaseAccountId: i.purchase_account_id ? asId(i.purchase_account_id) : null,
    preferredVendorId: i.preferred_vendor_id ? asId(i.preferred_vendor_id) : null,
    createdSource: i.created_source,
    qtySold: Number(soldBy.get(i.id)?.qty ?? 0),
    soldValuePaise: toPaiseFromSql(soldBy.get(i.id)?.value ?? '0'),
    // Margin per unit, which is the number that decides whether an item is
    // worth stocking. Shown only when both prices are known.
    marginPaise: toPaiseFromSql(i.sale_price) - toPaiseFromSql(i.purchase_price),
  }));
}
