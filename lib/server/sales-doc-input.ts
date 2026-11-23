// Quotes, sales orders, challans, credit notes and retainers as the create
// and edit routes take them (POST /api/sales-documents,
// PUT /api/sales-documents/[kind]/[id]): one schema, one mapping.

import { z } from 'zod';
import type { SalesDocInput } from './services/sales-documents';

export const LineInput = z.object({
  itemId: z.union([z.string(), z.number()]).nullish(),
  description: z.string().nullish(),
  hsnSac: z.string().nullish(),
  qty: z.number().positive(),
  uqc: z.string().nullish(),
  ratePaise: z.number().int().nonnegative().optional(),
  discountPct: z.number().min(0).max(100).optional(),
  gstRatePct: z.number().min(0).max(50).optional(),
  cessRatePct: z.number().min(0).max(300).optional(),
  /** A serial-tracked item coming back on a credit note: the number of each piece. */
  serials: z.array(z.string().trim().min(1).max(80)).max(5000).nullish(),
});

export const toNum = (v: string | number | null | undefined) => (v == null ? null : Number(v));
export const mapLines = (lines: z.infer<typeof LineInput>[]) =>
  lines.map((l) => ({ ...l, itemId: toNum(l.itemId) }));

export const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Give the date as yyyy-mm-dd.');

/** What Zoho's forms add to every one of these documents (migration 121). */
const ID = z.union([z.string(), z.number()]).nullish();
const ZOHO = {
  referenceNumber: z.string().trim().max(100).nullish(),
  salespersonId: ID,
  terms: z.string().max(5000).nullish(),
};

/** The Zoho fields of a body, as the services take them. */
export function zohoInput(input: { referenceNumber?: string | null; salespersonId?: string | number | null; terms?: string | null }) {
  return { referenceNumber: input.referenceNumber ?? null, salespersonId: toNum(input.salespersonId || null), terms: input.terms ?? null };
}

export const CreateInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('estimate'),
    branchId: z.union([z.string(), z.number()]),
    customerId: z.union([z.string(), z.number()]),
    date: DATE,
    expiryDate: DATE,
    lines: z.array(LineInput).min(1),
    placeOfSupply: z.string().length(2).optional(),
    notes: z.string().nullish(),
    status: z.enum(['draft', 'sent']).optional(),
    voucherTypeId: z.union([z.string(), z.number()]).nullish(),
    projectId: ID,
    ...ZOHO,
  }),
  z.object({
    kind: z.literal('sales-order'),
    branchId: z.union([z.string(), z.number()]),
    customerId: z.union([z.string(), z.number()]),
    date: DATE,
    expectedShipDate: DATE.nullish(),
    lines: z.array(LineInput).min(1),
    placeOfSupply: z.string().length(2).optional(),
    notes: z.string().nullish(),
    sourceEstimateId: z.union([z.string(), z.number()]).nullish(),
    voucherTypeId: z.union([z.string(), z.number()]).nullish(),
    paymentTerms: z.string().max(30).nullish(),
    deliveryMethod: z.string().max(100).nullish(),
    status: z.enum(['draft', 'open']).optional(),
    ...ZOHO,
  }),
  z.object({
    kind: z.literal('challan'),
    branchId: z.union([z.string(), z.number()]),
    customerId: z.union([z.string(), z.number()]),
    date: DATE,
    challanType: z.enum(['job_work', 'supply_on_approval', 'liquid_gas', 'other']).optional(),
    lines: z.array(LineInput).min(1),
    placeOfSupply: z.string().length(2).optional(),
    notes: z.string().nullish(),
    voucherTypeId: z.union([z.string(), z.number()]).nullish(),
    referenceNumber: ZOHO.referenceNumber,
    terms: ZOHO.terms,
    status: z.enum(['draft', 'open']).optional(),
  }),
  z.object({
    kind: z.literal('credit-note'),
    branchId: z.union([z.string(), z.number()]),
    customerId: z.union([z.string(), z.number()]),
    date: DATE,
    reason: z.string().trim().min(1, 'GST requires a reason on every credit note.').max(200),
    againstInvoiceId: z.union([z.string(), z.number()]).nullish(),
    applyImmediately: z.boolean().optional(),
    warehouseId: z.union([z.string(), z.number()]).nullish(),
    lines: z.array(LineInput).min(1),
    placeOfSupply: z.string().length(2).optional(),
    notes: z.string().nullish(),
    voucherTypeId: z.union([z.string(), z.number()]).nullish(),
    ...ZOHO,
  }),
  z.object({
    kind: z.literal('retainer'),
    branchId: z.union([z.string(), z.number()]),
    customerId: z.union([z.string(), z.number()]),
    date: DATE,
    description: z.string().trim().min(1, 'Say what the retainer covers.').max(500),
    amountPaise: z.number().int().positive(),
    status: z.enum(['draft', 'sent']).optional(),
  }),
]);

export type SalesDocBody = z.infer<typeof CreateInput>;

/** The body as the service's edit takes it; a retainer is not edited here. */
export function toSalesDocInput(input: SalesDocBody, branch: number): SalesDocInput {
  const customerId = Number(input.customerId);
  switch (input.kind) {
    case 'estimate':
      return { kind: 'estimate', input: {
        branchId: branch, customerId, date: input.date, expiryDate: input.expiryDate,
        lines: mapLines(input.lines), placeOfSupply: input.placeOfSupply,
        notes: input.notes, status: input.status, voucherTypeId: toNum(input.voucherTypeId),
        ...zohoInput(input), projectId: toNum(input.projectId || null),
      } };
    case 'sales-order':
      return { kind: 'sales-order', input: {
        branchId: branch, customerId, date: input.date, expectedShipDate: input.expectedShipDate ?? null,
        lines: mapLines(input.lines), placeOfSupply: input.placeOfSupply, notes: input.notes, voucherTypeId: toNum(input.voucherTypeId),
        ...zohoInput(input), paymentTerms: input.paymentTerms ?? null, deliveryMethod: input.deliveryMethod ?? null, status: input.status,
      } };
    case 'challan':
      return { kind: 'challan', input: {
        branchId: branch, customerId, date: input.date, challanType: input.challanType,
        lines: mapLines(input.lines), placeOfSupply: input.placeOfSupply, notes: input.notes, voucherTypeId: toNum(input.voucherTypeId),
        referenceNumber: input.referenceNumber ?? null, terms: input.terms ?? null, status: input.status,
      } };
    case 'credit-note':
      return { kind: 'credit-note', input: {
        branchId: branch, customerId, date: input.date, reason: input.reason,
        againstInvoiceId: toNum(input.againstInvoiceId), applyImmediately: input.applyImmediately,
        warehouseId: toNum(input.warehouseId),
        lines: mapLines(input.lines), placeOfSupply: input.placeOfSupply, notes: input.notes, voucherTypeId: toNum(input.voucherTypeId),
        ...zohoInput(input),
      } };
    default:
      throw new Error('A retainer invoice is not edited here.');
  }
}
