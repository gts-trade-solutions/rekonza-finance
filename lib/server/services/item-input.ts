import { z } from 'zod';

// What a new item and an item edit may carry (app/api/items/route.ts).

// The fields with no defaults: an edit names only what it changes. Zod 4 fills
// a default in even where a field is optional, so a default on the shared
// shape would have every edit reset what it left out (the unit to NOS, the
// cost to nothing, the tax preference to taxable). The defaults belong to a
// new item alone (ItemInput, below).
export const ItemFields = z.object({
  kind: z.enum(['goods', 'service']),
  name: z.string().trim().min(1, 'An item needs a name.').max(200),
  sku: z.string().trim().max(60).nullish(),
  hsnSac: z.string().trim().max(8).nullish(),
  uqc: z.string().trim().max(10),
  salePricePaise: z.number().int().min(0),
  purchasePricePaise: z.number().int().min(0),
  gstRatePct: z.number().min(0).max(50),
  taxPref: z.enum(['taxable', 'exempt', 'nil', 'non_gst']),
  description: z.string().trim().max(1000).nullish(),
  /** Made or bought in India, or imported: IGST at customs (goods) or by reverse charge (a service). */
  origin: z.enum(['local', 'imported']).optional(),
  trackInventory: z.boolean().optional(),
  trackBatches: z.boolean().optional(),
  reorderLevel: z.number().min(0).nullish(),
  // Stock on hand when the books began, and what it was carried at. Opening
  // stock is an opening balance: it reaches the balance sheet through opening
  // equity, never through profit.
  openingStockQty: z.number().min(0).nullish(),
  openingStockRatePaise: z.number().int().min(0).nullish(),
  /** The price printed on the pack. A sale above it is flagged. */
  mrpPaise: z.number().int().min(0).nullish(),
  /** What a unit is budgeted to cost, set against what it actually costs. */
  standardCostPaise: z.number().int().min(0).nullish(),
  /** A second unit it is counted in, and how many of the main unit make one. */
  altUqc: z.string().trim().max(10).nullish(),
  altFactor: z.number().positive().nullish(),
  /** Below this the item is short, not merely due for buying. */
  minLevel: z.number().min(0).nullish(),
  trackSerials: z.boolean().optional(),
  stockGroupId: z.coerce.number().int().positive().nullish(),
  /** Null follows the book's method. */
  valuationMethod: z.enum(['average', 'fifo']).nullish(),
  /** Sold as a set: its components and how many of each (services/kits.ts). Empty makes it an ordinary item again. */
  kitComponents: z.array(z.object({ itemId: z.coerce.number().int().positive(), qty: z.number().positive() })).max(50).optional(),
  // ── Zoho's item fields (migration 111) ──
  /** Zoho's Sales Information and Purchase Information ticks: sold, bought, or both. */
  itemType: z.enum(['sales', 'purchases', 'sales_and_purchases']),
  /** "It is a digital service" (OIDAR), for a service. */
  isDigitalService: z.boolean(),
  upc: z.string().trim().max(20).nullish(),
  ean: z.string().trim().max(20).nullish(),
  isbn: z.string().trim().max(20).nullish(),
  mpn: z.string().trim().max(40).nullish(),
  /** What a bill or purchase order line says; the description is what a sale says. */
  purchaseDescription: z.string().trim().max(1000).nullish(),
  /** The income account an invoice line for it credits. Null is Sales. */
  saleAccountId: z.coerce.number().int().positive().nullish(),
  /** The account a bill line for it debits. Null is Purchases. */
  purchaseAccountId: z.coerce.number().int().positive().nullish(),
  /** Who it is usually bought from: a new purchase order starts with them. */
  preferredVendorId: z.coerce.number().int().positive().nullish(),
});

/** A new item: what it does not say takes the usual values. */
export const ItemInput = ItemFields.extend({
  uqc: ItemFields.shape.uqc.default('NOS'),
  purchasePricePaise: ItemFields.shape.purchasePricePaise.default(0),
  taxPref: ItemFields.shape.taxPref.default('taxable'),
  itemType: ItemFields.shape.itemType.default('sales_and_purchases'),
  isDigitalService: ItemFields.shape.isDigitalService.default(false),
});

/** An edit: only what it names changes. */
export const UpdateInput = ItemFields.partial().extend({
  id: z.string(),
  isArchived: z.boolean().optional(),
  /** The record's updatedAt as it was read: the edit is refused if it has changed since. */
  expectedUpdatedAt: z.string().optional(),
});
