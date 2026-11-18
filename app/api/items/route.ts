import { z } from 'zod';
import { sql } from 'kysely';
import { db, transaction } from '@/lib/server/db';
import { saveKit } from '@/lib/server/services/kits';
import { route, body, query, asId, badRequest, conflict } from '@/lib/server/http';
import { toSqlFromPaise } from '@/lib/server/money-sql';
import { assertFresh } from '@/lib/server/concurrency';
import { logAudit, auditMeta, snapshot, changesBetween, describeChanges } from '@/lib/server/audit';
import { CODE, accountIds } from '@/lib/server/ledger/chart-of-accounts';
import { selectItems, shapeItems } from '@/lib/server/services/item-read';
import { ItemInput, UpdateInput } from '@/lib/server/services/item-input';

const ListQuery = z.object({
  kind: z.enum(['goods', 'service', 'all']).optional(),
  search: z.string().optional(),
  archived: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(300),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * The item catalogue, with how much each item has actually sold
 * (services/item-read.ts, which one item's own page reads too).
 */
export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, ListQuery);

    let base = selectItems(orgId);
    if (!q.archived) base = base.where('is_archived', '=', 0);
    if (q.kind && q.kind !== 'all') base = base.where('kind', '=', q.kind);
    if (q.search) {
      const term = `%${q.search}%`;
      base = base.where((eb) =>
        eb.or([eb('name', 'like', term), eb('sku', 'like', term), eb('hsn_sac', 'like', term)]),
      );
    }

    const rows = await base.orderBy('name').limit(q.limit).offset(q.offset).execute();
    return { items: await shapeItems(orgId, rows) };
  },
  { permission: { module: 'sales', action: 'view' } },
);

/** A stock group has to be one of the book's own. */
async function checkGroup(orgId: number, id: number | null | undefined) {
  if (!id) return;
  const g = await db.selectFrom('stock_groups').select('id').where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!g) throw badRequest('That stock group does not exist.');
}

/**
 * The item's accounts and vendor have to be the book's own: a sales account an
 * income head, a purchase account an expense (or, for capital goods, an asset),
 * the preferred vendor a vendor.
 */
async function checkLinks(orgId: number, m: { saleAccountId?: number | null; purchaseAccountId?: number | null; preferredVendorId?: number | null }) {
  const account = async (id: number, types: string[], what: string) => {
    const a = await db.selectFrom('accounts').select(['type', 'name', 'is_active']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
    if (!a) throw badRequest(`That ${what} is not in your chart of accounts.`);
    if (!types.includes(a.type)) throw badRequest(`${a.name} is ${a.type === 'income' ? 'an income' : `an ${a.type}`} account; the ${what} has to be ${types.length > 1 ? 'an expense or asset' : `an ${types[0]}`} account.`);
    if (!a.is_active) throw badRequest(`${a.name} is switched off in the chart of accounts.`);
  };
  if (m.saleAccountId) await account(m.saleAccountId, ['income'], 'sales account');
  if (m.purchaseAccountId) await account(m.purchaseAccountId, ['expense', 'asset'], 'purchase account');
  if (m.preferredVendorId) {
    const v = await db.selectFrom('contacts').select('kind').where('id', '=', m.preferredVendorId).where('org_id', '=', orgId).executeTakeFirst();
    if (!v || (v.kind !== 'vendor' && v.kind !== 'both')) throw badRequest('The preferred vendor has to be one of your vendors.');
  }
}

/** A product code: letters, digits and dashes, as printed under a barcode. */
const code = (v: string | null | undefined) => (v ? v.trim().toUpperCase() || null : v);

/** The master's own rules, on what the item will be once saved. */
function checkMaster(m: { uqc?: string | null; altUqc?: string | null; altFactor?: number | null; minLevel?: number | null; reorderLevel?: number | null }) {
  if (m.altUqc) {
    if (!m.altFactor) throw badRequest(`Say how many ${m.uqc ?? 'units'} make one ${m.altUqc}.`);
    if (m.altUqc.toUpperCase() === (m.uqc ?? '').toUpperCase()) throw badRequest('The second unit has to differ from the main one.');
  }
  if (m.minLevel != null && m.reorderLevel != null && m.minLevel > m.reorderLevel) {
    throw badRequest('The minimum level is the floor; the reorder level sits at or above it.');
  }
}

/**
 * An HSN/SAC on an item has to be one the organisation has approved, for the
 * same reason it does on an invoice line: GSTR-1 Table 12 is validated against
 * the official master and one bad code bounces the whole return.
 *
 * The kind also has to match. SAC codes begin 99 and describe services; putting
 * one on a goods item files the supply in the wrong table.
 */
async function checkHsn(orgId: number, hsn: string | null | undefined, kind: 'goods' | 'service' | undefined) {
  if (!hsn) return;
  const row = await db
    .selectFrom('hsn_codes')
    .select(['code', 'kind', 'is_active'])
    .where('org_id', '=', orgId)
    .where('code', '=', hsn)
    .executeTakeFirst();
  if (!row || !row.is_active) {
    throw badRequest(
      `HSN/SAC ${hsn} is not on the approved list. An admin can add it under Settings → HSN & SAC Codes.`,
    );
  }
  if (kind && ((kind === 'service') !== (row.kind === 'sac'))) {
    throw badRequest(
      `${hsn} is ${row.kind === 'sac' ? 'a SAC, which describes a service' : 'an HSN, which describes goods'} — ` +
        `but this item is ${kind}.`,
    );
  }
}

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, ItemInput);
    await checkHsn(orgId, input.hsnSac, input.kind);
    checkMaster(input);
    await checkGroup(orgId, input.stockGroupId);
    await checkLinks(orgId, input);

    // Which income and expense heads this item posts to. The posting engine
    // falls back to Sales and Purchases when these are null, so an item without
    // them still works — but then the columns say nothing, and an item created
    // through the API would differ from one the seed made. Goods and services
    // are separate income heads because the P&L is more useful when they are.
    const acc = await accountIds(db, orgId);
    const saleAccountId = input.saleAccountId
      ?? acc[input.kind === 'service' ? CODE.SERVICE_INCOME : CODE.SALES] ?? null;
    const purchaseAccountId = input.purchaseAccountId ?? acc[CODE.PURCHASES] ?? null;

    const inserted = await db
      .insertInto('items')
      .values({
        org_id: orgId,
        kind: input.kind,
        sale_account_id: saleAccountId,
        purchase_account_id: purchaseAccountId,
        name: input.name,
        sku: input.sku ?? null,
        hsn_sac: input.hsnSac ?? null,
        uqc: input.uqc,
        sale_price: toSqlFromPaise(input.salePricePaise),
        purchase_price: toSqlFromPaise(input.purchasePricePaise),
        gst_rate_pct: input.gstRatePct,
        tax_pref: input.taxPref,
        description: input.description ?? null,
        origin: input.origin ?? 'local',
        track_inventory: input.trackInventory ? 1 : 0,
        track_batches: input.trackBatches && input.trackInventory ? 1 : 0,
        reorder_level: input.reorderLevel ?? null,
        opening_stock_qty: input.openingStockQty == null ? null : String(input.openingStockQty),
        opening_stock_rate: input.openingStockRatePaise == null ? null : toSqlFromPaise(input.openingStockRatePaise),
        mrp: input.mrpPaise == null ? null : toSqlFromPaise(input.mrpPaise),
        standard_cost: input.standardCostPaise == null ? null : toSqlFromPaise(input.standardCostPaise),
        alt_uqc: input.altUqc ? input.altUqc.toUpperCase() : null,
        alt_factor: input.altUqc && input.altFactor ? String(input.altFactor) : null,
        min_level: input.minLevel ?? null,
        track_serials: input.trackSerials && input.trackInventory ? 1 : 0,
        stock_group_id: input.stockGroupId ?? null,
        valuation_method: input.valuationMethod ?? null,
        item_type: input.itemType,
        is_digital_service: input.kind === 'service' && input.isDigitalService ? 1 : 0,
        upc: code(input.upc) ?? null,
        ean: code(input.ean) ?? null,
        isbn: code(input.isbn) ?? null,
        mpn: code(input.mpn) ?? null,
        purchase_description: input.purchaseDescription ?? null,
        preferred_vendor_id: input.preferredVendorId ?? null,
      })
      .executeTakeFirstOrThrow();

    const id = Number(inserted.insertId);
    if (input.kitComponents?.length) await transaction((trx) => saveKit(trx, orgId, id, input.kitComponents!));
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
      targetType: 'item', targetId: id, targetLabel: input.name,
      detail: `Added ${input.kind} "${input.name}"`, ...auditMeta(req),
    });

    return { id: asId(id), name: input.name };
  },
  { permission: { module: 'sales', action: 'create' } },
);

export const PATCH = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, UpdateInput);
    const id = Number(input.id);

    const existing = await db
      .selectFrom('items')
      .select(['id', 'name', 'kind', 'hsn_sac', 'uqc', 'alt_uqc', 'alt_factor', 'min_level', 'reorder_level'])
      .where('id', '=', id)
      .where('org_id', '=', orgId)
      .executeTakeFirst();
    if (!existing) throw badRequest('That item does not exist.');
    await assertFresh(db, 'items', orgId, id, input.expectedUpdatedAt, existing.name);

    await checkHsn(
      orgId,
      input.hsnSac === undefined ? existing.hsn_sac : input.hsnSac,
      (input.kind ?? existing.kind) as 'goods' | 'service',
    );
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    checkMaster({
      uqc: input.uqc ?? existing.uqc,
      altUqc: input.altUqc === undefined ? existing.alt_uqc : input.altUqc,
      altFactor: input.altFactor === undefined ? num(existing.alt_factor) : input.altFactor,
      minLevel: input.minLevel === undefined ? num(existing.min_level) : input.minLevel,
      reorderLevel: input.reorderLevel === undefined ? num(existing.reorder_level) : input.reorderLevel,
    });
    await checkGroup(orgId, input.stockGroupId);
    await checkLinks(orgId, input);

    if (input.isArchived) {
      // Archiving an item used on a document that is still open would leave
      // that document referring to something the pickers can no longer show.
      const open = await db
        .selectFrom('invoice_lines')
        .innerJoin('invoices', 'invoices.id', 'invoice_lines.invoice_id')
        .select(sql<string>`COUNT(*)`.as('n'))
        .where('invoices.org_id', '=', orgId)
        .where('invoice_lines.item_id', '=', id)
        .where('invoices.status', '=', 'draft')
        .executeTakeFirst();
      if (Number(open?.n ?? 0) > 0) {
        throw conflict(`"${existing.name}" is on a draft invoice. Remove it there first, or issue the draft.`);
      }
    }

    const patch: Record<string, unknown> = {};
    const set = (col: string, v: unknown) => { if (v !== undefined) patch[col] = v; };
    set('kind', input.kind);
    set('name', input.name);
    set('sku', input.sku);
    set('hsn_sac', input.hsnSac);
    set('uqc', input.uqc);
    set('sale_price', input.salePricePaise === undefined ? undefined : toSqlFromPaise(input.salePricePaise));
    set('purchase_price', input.purchasePricePaise === undefined ? undefined : toSqlFromPaise(input.purchasePricePaise));
    set('gst_rate_pct', input.gstRatePct);
    set('tax_pref', input.taxPref);
    set('description', input.description);
    set('origin', input.origin);
    set('track_inventory', input.trackInventory === undefined ? undefined : input.trackInventory ? 1 : 0);
    set('track_batches', input.trackBatches === undefined ? undefined : input.trackBatches ? 1 : 0);
    set('reorder_level', input.reorderLevel);
    set('opening_stock_qty', input.openingStockQty === undefined ? undefined
      : input.openingStockQty === null ? null : String(input.openingStockQty));
    set('opening_stock_rate', input.openingStockRatePaise === undefined ? undefined
      : input.openingStockRatePaise === null ? null : toSqlFromPaise(input.openingStockRatePaise));
    set('is_archived', input.isArchived === undefined ? undefined : input.isArchived ? 1 : 0);
    set('mrp', input.mrpPaise === undefined ? undefined : input.mrpPaise === null ? null : toSqlFromPaise(input.mrpPaise));
    set('standard_cost', input.standardCostPaise === undefined ? undefined
      : input.standardCostPaise === null ? null : toSqlFromPaise(input.standardCostPaise));
    set('alt_uqc', input.altUqc === undefined ? undefined : input.altUqc ? input.altUqc.toUpperCase() : null);
    // No second unit, no factor for it.
    set('alt_factor', input.altUqc === null || input.altUqc === '' ? null
      : input.altFactor === undefined ? undefined : input.altFactor === null ? null : String(input.altFactor));
    set('min_level', input.minLevel);
    set('track_serials', input.trackSerials === undefined ? undefined : input.trackSerials ? 1 : 0);
    set('stock_group_id', input.stockGroupId);
    set('valuation_method', input.valuationMethod);
    set('item_type', input.itemType);
    // Only a service is a digital service.
    set('is_digital_service', input.isDigitalService === undefined ? undefined
      : input.isDigitalService && (input.kind ?? existing.kind) === 'service' ? 1 : 0);
    set('upc', code(input.upc));
    set('ean', code(input.ean));
    set('isbn', code(input.isbn));
    set('mpn', code(input.mpn));
    set('purchase_description', input.purchaseDescription);
    set('sale_account_id', input.saleAccountId);
    set('purchase_account_id', input.purchaseAccountId);
    set('preferred_vendor_id', input.preferredVendorId);

    const before = await snapshot(db, 'items', orgId, id, Object.keys(patch));
    if (Object.keys(patch).length) {
      await db.updateTable('items').set(patch).where('id', '=', id).where('org_id', '=', orgId).execute();
    }
    const changes = changesBetween(before, patch);
    if (input.kitComponents !== undefined) await transaction((trx) => saveKit(trx, orgId, id, input.kitComponents!));

    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
      targetType: 'item', targetId: id, targetLabel: existing.name,
      detail: `${input.isArchived ? 'Archived' : 'Updated'} "${existing.name}": ${describeChanges(changes)}`,
      payload: { changes }, ...auditMeta(req),
    });

    return { id: asId(id) };
  },
  { permission: { module: 'sales', action: 'edit' } },
);
