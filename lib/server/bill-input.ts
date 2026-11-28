import 'server-only';
import { z } from 'zod';
import type { CreateBillInput } from './services/purchases';

// What a bill is entered with: shared by New (POST /api/bills) and Edit
// (PUT /api/bills/[id]), so an edited bill is checked exactly as a new one.

export const BillLineInput = z.object({
  itemId: z.string().nullish(),
  accountId: z.string().nullish(),
  description: z.string().nullish(),
  hsnSac: z.string().nullish(),
  qty: z.number().positive('Quantity must be above zero.'),
  uqc: z.string().nullish(),
  ratePaise: z.number().int().nonnegative(),
  discountPct: z.number().min(0).max(100).optional(),
  gstRatePct: z.number().min(0).max(50).optional(),
  cessRatePct: z.number().min(0).max(300).optional(),
  itcEligibility: z.enum(['eligible', 'ineligible', 'capital_goods']).optional(),
  /** A batch-tracked item: the batch bought and its dates. */
  batch: z.object({ batchNo: z.string().trim().max(40), mfgDate: z.string().nullish(), expiryDate: z.string().nullish() }).nullish(),
  /** A serial-tracked item: the number of each piece, one per unit. */
  serials: z.array(z.string().trim().min(1).max(80)).max(5000).nullish(),
  /** Edit only: the order or receipt-note line this line was billed from, kept as it was. */
  sourceLineType: z.enum(['purchase_order', 'goods_receipt']).nullish(),
  sourceLineId: z.union([z.string(), z.number()]).nullish(),
});

export const BillInput = z.object({
  branchId: z.string(),
  vendorId: z.string(),
  /** The cost centre the document's income or expense belongs to. */
  costCentreId: z.union([z.string(), z.number()]).nullish(),
  warehouseId: z.union([z.string(), z.number()]).nullish(),
  vendorInvoiceNo: z.string().min(1, "Enter the vendor's invoice number."),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.'),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.'),
  lines: z.array(BillLineInput).min(1, 'Add at least one line.'),
  isRcm: z.boolean().optional(),
  tdsSectionOverride: z.string().nullish(),
  notes: z.string().nullish(),
  status: z.enum(['draft', 'open']).optional(),
  /** Why it is not a duplicate of a bill it looks like (services/bill-duplicates.ts). */
  duplicateReason: z.string().trim().max(500).nullish(),
  /** Priced in another currency: amounts in its minor unit, booked in rupees at the rate. */
  currency: z.string().trim().toUpperCase().length(3).optional(),
  exchangeRate: z.number().positive().optional(),
});

/**
 * The service's input from the request. `keepSources` (Edit) carries each
 * line's order or receipt-note line through; a new bill never takes one from
 * the browser, or quantities could be billed without being counted.
 */
export function toBillInput(input: z.infer<typeof BillInput>, opts: { keepSources?: boolean } = {}): CreateBillInput {
  return {
    branchId: Number(input.branchId),
    costCentreId: input.costCentreId ? Number(input.costCentreId) : null,
    warehouseId: input.warehouseId ? Number(input.warehouseId) : null,
    vendorId: Number(input.vendorId),
    vendorInvoiceNo: input.vendorInvoiceNo,
    date: input.date,
    dueDate: input.dueDate,
    isRcm: input.isRcm,
    tdsSectionOverride: input.tdsSectionOverride,
    currency: input.currency,
    exchangeRate: input.exchangeRate,
    notes: input.notes,
    status: input.status,
    duplicateReason: input.duplicateReason ?? null,
    lines: input.lines.map((l) => ({
      itemId: l.itemId ? Number(l.itemId) : null,
      accountId: l.accountId ? Number(l.accountId) : null,
      description: l.description,
      hsnSac: l.hsnSac,
      qty: l.qty,
      uqc: l.uqc,
      ratePaise: l.ratePaise,
      discountPct: l.discountPct,
      gstRatePct: l.gstRatePct,
      cessRatePct: l.cessRatePct,
      batch: l.batch?.batchNo ? l.batch : null,
      serials: l.serials,
      itcEligibility: l.itcEligibility,
    })),
    lineSources: opts.keepSources
      ? input.lines.map((l) => (l.sourceLineType && l.sourceLineId ? { type: l.sourceLineType, id: Number(l.sourceLineId) } : null))
      : undefined,
  };
}
