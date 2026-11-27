import { z } from 'zod';
import type { BillOfEntryInput } from './services/bill-of-entry';

// The bill of entry as the form sends it, shared by New (POST /api/bills-of-entry)
// and Edit (PUT /api/bills-of-entry/[id]): a route file may only export its handlers.

const id = z.union([z.string(), z.number()]);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.');

export const BillOfEntryBody = z.object({
  branchId: id, vendorId: id.nullish(), billId: id.nullish(),
  boeNo: z.string().trim().min(1).max(20), boeDate: DATE, portCode: z.string().trim().min(1).max(6),
  assessablePaise: z.number().int().nonnegative(), customsDutyPaise: z.number().int().nonnegative(),
  igstPaise: z.number().int().nonnegative(), cessPaise: z.number().int().nonnegative().optional(),
  itcEligibility: z.enum(['eligible', 'ineligible', 'capital_goods']).optional(),
  dutyAccountId: id, paidThroughBankAccountId: id, notes: z.string().trim().max(500).nullish(),
});

export function toBillOfEntryInput(input: z.infer<typeof BillOfEntryBody>): BillOfEntryInput {
  return {
    ...input, branchId: Number(input.branchId), vendorId: input.vendorId ? Number(input.vendorId) : null,
    billId: input.billId ? Number(input.billId) : null, dutyAccountId: Number(input.dutyAccountId),
    paidThroughBankAccountId: Number(input.paidThroughBankAccountId),
  };
}
