// An expense as the record and edit routes take it (POST /api/expenses,
// PUT /api/expenses/[id]): one schema, one mapping.

import { z } from 'zod';
import type { CreateExpenseInput } from './services/purchases';

export const ExpenseInput = z.object({
  branchId: z.string(),
  /** The cost centre the document's income or expense belongs to. */
  costCentreId: z.union([z.string(), z.number()]).nullish(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.'),
  accountId: z.string(),
  paidThroughBankAccountId: z.string(),
  // Left out for mileage, where it is the distance times the rate.
  amountPaise: z.number().int().nonnegative().default(0),
  gstRatePct: z.number().min(0).max(50).optional(),
  vendorId: z.string().nullish(),
  itcEligibility: z.enum(['eligible', 'ineligible', 'capital_goods']).optional(),
  isBillable: z.boolean().optional(),
  billableCustomerId: z.string().nullish(),
  projectId: z.union([z.string(), z.number()]).nullish(),
  reference: z.string().nullish(),
  /** Why it is not a duplicate of a supplier invoice it looks like (services/bill-duplicates.ts). */
  duplicateReason: z.string().trim().max(500).nullish(),
  notes: z.string().nullish(),
  /** A journey claimed by the kilometre; the amount is worked out from it. */
  mileage: z.object({ km: z.number().positive().max(100000), ratePaise: z.number().int().positive().max(100000) }).nullish(),
});

export type ExpenseBody = z.infer<typeof ExpenseInput>;

export function toExpenseInput(input: ExpenseBody): CreateExpenseInput {
  return {
    branchId: Number(input.branchId),
    costCentreId: input.costCentreId ? Number(input.costCentreId) : null,
    date: input.date,
    accountId: Number(input.accountId),
    paidThroughBankAccountId: Number(input.paidThroughBankAccountId),
    amountPaise: input.amountPaise,
    gstRatePct: input.gstRatePct,
    vendorId: input.vendorId ? Number(input.vendorId) : null,
    itcEligibility: input.itcEligibility,
    isBillable: input.isBillable,
    billableCustomerId: input.billableCustomerId ? Number(input.billableCustomerId) : null,
    projectId: input.projectId ? Number(input.projectId) : null,
    reference: input.reference,
    duplicateReason: input.duplicateReason ?? null,
    notes: input.notes,
    mileage: input.mileage ?? null,
  };
}
