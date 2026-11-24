// A recurring invoice profile as Zoho's form sends it (services/recurring-profiles.ts).

import { z } from 'zod';
import type { Frequency } from '@/lib/server/services/recurring';

const FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'] as const;

const LineInput = z.object({
  itemId: z.union([z.string(), z.number()]).nullish(),
  description: z.string().nullish(),
  qty: z.number().positive(),
  ratePaise: z.number().int().nonnegative(),
  gstRatePct: z.number().min(0).max(50).default(18),
  hsnSac: z.string().nullish(),
  discountPct: z.number().min(0).max(100).optional(),
});

export const CreateInput = z.object({
  name: z.string().trim().max(200),
  customerId: z.union([z.string(), z.number()]).nullish(),
  orderNumber: z.string().max(100).nullish(),
  frequency: z.enum(FREQUENCIES),
  /** Zoho's "Repeat Every" count: 2 Weeks, 6 Months, every 10 Days (migration 123). */
  every: z.number().int().min(1).max(999).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  paymentTerms: z.string().max(20).nullish(),
  salespersonId: z.union([z.string(), z.number()]).nullish(),
  notes: z.string().max(4000).nullish(),
  terms: z.string().max(4000).nullish(),
  priceListId: z.union([z.string(), z.number()]).nullish(),
  projectIds: z.array(z.union([z.string(), z.number()])).max(20).optional(),
  paymentLink: z.boolean().optional(),
  createAsDraft: z.boolean().optional(),
  autoSend: z.boolean().optional(),
  autoRun: z.boolean().optional(),
  lines: z.array(LineInput).min(1, 'Enter the valid item name or description.'),
});

/** The form's input as the profile service takes it. */
export const toProfileInput = (input: z.infer<typeof CreateInput>, branchId: number) => ({
  branchId, customerId: Number(input.customerId ?? 0), name: input.name, orderNumber: input.orderNumber ?? null,
  frequency: input.frequency as Frequency, every: input.every ?? 1, startDate: input.startDate, endDate: input.endDate ?? null,
  paymentTerms: input.paymentTerms ?? null, salespersonId: input.salespersonId ? Number(input.salespersonId) : null,
  notes: input.notes ?? null, terms: input.terms ?? null, createAsDraft: !!input.createAsDraft, autoSend: !!input.autoSend, autoRun: !!input.autoRun,
  priceListId: input.priceListId ? Number(input.priceListId) : null,
  projectIds: (input.projectIds ?? []).map(Number).filter((n) => n > 0),
  paymentLink: !!input.paymentLink,
  lines: input.lines.map((l) => ({
    itemId: l.itemId == null || l.itemId === '' ? null : Number(l.itemId), description: l.description ?? null,
    qty: l.qty, ratePaise: l.ratePaise, gstRatePct: l.gstRatePct, hsnSac: l.hsnSac ?? null, discountPct: l.discountPct ?? 0,
  })),
});

