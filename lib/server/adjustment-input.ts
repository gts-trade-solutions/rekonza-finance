import { z } from 'zod';
import type { AdjustmentInput } from './services/stock-changes';

// A stock adjustment as New and Edit send it (app/api/inventory, and
// app/api/inventory/adjustments/[id]), and as services/stock-changes.ts takes it.

export const AdjustInput = z.object({
  itemId: z.union([z.string(), z.number()]),
  warehouseId: z.union([z.string(), z.number()]).nullish(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.'),
  qtyDelta: z.number().refine((v) => v !== 0, 'An adjustment of zero changes nothing.'),
  reason: z.enum(['damage', 'theft', 'stocktake', 'expiry', 'sample', 'opening', 'other', 'issued']),
  notes: z.string().trim().max(500).nullish(),
  /** A batch-tracked item: which batch, made if new (with its dates) on an opening or a found count. */
  batch: z.object({ batchNo: z.string().trim().min(1).max(40), mfgDate: z.string().nullish(), expiryDate: z.string().nullish() }).nullish(),
  /** A serial-tracked item: the number of each piece found or written off. */
  serials: z.array(z.string().trim().min(1).max(80)).max(5000).nullish(),
});

/** The request as the service takes it. */
export const toAdjustment = (input: z.infer<typeof AdjustInput>): AdjustmentInput => ({
  itemId: Number(input.itemId), warehouseId: input.warehouseId ? Number(input.warehouseId) : null, date: input.date,
  qtyDelta: input.qtyDelta, reason: input.reason, notes: input.notes ?? null, batch: input.batch ?? null, serials: input.serials ?? null,
});

