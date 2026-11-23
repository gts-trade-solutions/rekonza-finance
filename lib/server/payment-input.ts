// A payment as the record and edit routes take it (POST /api/payments,
// PUT /api/payments/[id]): one schema and one mapping.

import { z } from 'zod';
import type { RecordPaymentInput } from './services/payments';

export const PaymentInput = z.object({
  kind: z.enum(['received', 'made']),
  branchId: z.string(),
  contactId: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.'),
  mode: z.enum(['cash', 'cheque', 'neft', 'rtgs', 'imps', 'upi', 'card', 'netbanking', 'other']),
  amountPaise: z.number().int().positive('Enter an amount above zero.'),
  bankAccountId: z.string(),
  reference: z.string().nullish(),
  tdsPaise: z.number().int().nonnegative().optional(),
  bankChargesPaise: z.number().int().nonnegative().optional(),
  notes: z.string().nullish(),
  allocations: z
    .array(
      z.object({
        targetType: z.enum(['invoice', 'bill', 'credit_note', 'vendor_credit', 'retainer', 'opening']),
        targetId: z.string(),
        // Worked out from the foreign amount when the payment is in another currency.
        amountPaise: z.number().int().nonnegative(),
        foreignAmountPaise: z.number().int().positive().optional(),
      }),
    )
    .optional(),
  /** An advance for services: GST on what is left unapplied is due now. */
  advanceGst: z.object({
    ratePct: z.number().positive().max(40),
    placeOfSupply: z.string().regex(/^\d{2}$/).nullish(),
  }).optional(),
  /** Received or paid in another currency; amountPaise is then the rupees in the bank. */
  fx: z.object({
    currency: z.string().trim().toUpperCase().length(3),
    rate: z.number().positive(),
    foreignAmountPaise: z.number().int().positive(),
  }).optional(),
});

export type PaymentBody = z.infer<typeof PaymentInput>;

/** The body as the payment service takes it. */
export function toPaymentInput(input: PaymentBody): RecordPaymentInput {
  return {
    branchId: Number(input.branchId),
    contactId: Number(input.contactId),
    date: input.date,
    mode: input.mode,
    amountPaise: input.amountPaise,
    bankAccountId: Number(input.bankAccountId),
    reference: input.reference,
    tdsPaise: input.tdsPaise,
    bankChargesPaise: input.bankChargesPaise,
    notes: input.notes,
    allocations: (input.allocations ?? []).map((a) => ({
      targetType: a.targetType,
      targetId: Number(a.targetId),
      amountPaise: a.amountPaise,
      foreignAmountPaise: a.foreignAmountPaise,
    })),
    advanceGst: input.advanceGst ?? null,
    fx: input.fx ?? null,
  };
}
