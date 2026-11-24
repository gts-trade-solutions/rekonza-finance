// A retainer invoice as Zoho's form sends it (services/retainers.ts).

import { z } from 'zod';
import type { RetainerFormInput } from '@/lib/server/services/retainers';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const id = z.union([z.string(), z.number()]);

export const RetainerInput = z.object({
  branchId: id,
  customerId: id,
  date: DATE,
  reference: z.string().trim().max(100).nullish(),
  projectId: id.nullish(),
  lines: z.array(z.object({ description: z.string().max(500), amountPaise: z.number().int().min(0) })).min(1).max(50),
  notes: z.string().max(4000).nullish(),
  terms: z.string().max(4000).nullish(),
  status: z.enum(['draft', 'sent']).optional(),
});

export const toRetainerInput = (i: z.infer<typeof RetainerInput>): RetainerFormInput => ({
  branchId: Number(i.branchId), customerId: Number(i.customerId), date: i.date,
  reference: i.reference ?? null, projectId: i.projectId ? Number(i.projectId) : null,
  lines: i.lines, notes: i.notes ?? null, terms: i.terms ?? null, status: i.status,
});
