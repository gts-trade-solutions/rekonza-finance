// The invoice as the create and edit routes take it (POST /api/invoices,
// PUT /api/invoices/[id]): one schema and one mapping, so an edit is checked
// exactly as the original was.

import { z } from 'zod';
import type { CreateInvoiceInput } from './services/sales';
import { hasPermission } from '../rbac';
import type { RoleName } from '../types';

export const LineInput = z.object({
  itemId: z.string().nullish(),
  description: z.string().nullish(),
  hsnSac: z.string().nullish(),
  qty: z.number().positive('Quantity must be above zero.'),
  uqc: z.string().nullish(),
  ratePaise: z.number().int('Rates are in whole paise.').nonnegative(),
  discountPct: z.number().min(0).max(100).optional(),
  gstRatePct: z.number().min(0).max(50).optional(),
  cessRatePct: z.number().min(0).max(300).optional(),
  /** A batch-tracked item: the batch sold; left out, the first to expire. */
  batchId: z.string().nullish(),
  /** A serial-tracked item: the number of each piece, one per unit. */
  serials: z.array(z.string().trim().min(1).max(80)).max(5000).nullish(),
  /** On an edit: the sales order or challan line this line was invoiced from, kept as it was. */
  sourceLineType: z.enum(['sales_order', 'challan']).nullish(),
  sourceLineId: z.union([z.string(), z.number()]).nullish(),
});

export const CreateInput = z.object({
  branchId: z.string(),
  customerId: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.'),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.'),
  lines: z.array(LineInput).min(1, 'Add at least one line.'),
  placeOfSupply: z.string().length(2).optional(),
  supplyKind: z.enum(['goods', 'service', 'both']).optional(),
  /** An export: true pays IGST, false goes under the LUT with IGST nil. Left out, the organisation's setting decides. */
  exportWithTax: z.boolean().optional(),
  status: z.enum(['draft', 'approved']).optional(),
  number: z.string().optional(),
  orderNumber: z.string().nullish(),
  subject: z.string().nullish(),
  paymentTerms: z.string().nullish(),
  salespersonId: z.string().nullish(),
  notes: z.string().nullish(),
  terms: z.string().nullish(),
  shippingChargePaise: z.number().int().optional(),
  /** Zoho's reverse charge checkbox, and its New Bill Of Supply (migration 124). */
  reverseCharge: z.boolean().optional(),
  billOfSupply: z.boolean().optional(),
  /** Sold through an e-commerce operator: its GSTIN, and TCS (s.52) or the operator pays the tax (s.9(5)). */
  eco: z.object({
    gstin: z.string().trim().toUpperCase().length(15, 'A GSTIN is 15 characters.'),
    section: z.enum(['52', '9_5']),
  }).nullish(),
  adjustmentPaise: z.number().int().optional(),
  adjustmentLabel: z.string().nullish(),
  // The TCS head; the server applies the rate in force on the invoice date.
  tcsCode: z.string().trim().max(20).nullish(),
  tcsPaise: z.number().int().optional(),
  // Where the goods go, when not to the customer's own address. It moves the
  // place of supply for goods (section 10 of the IGST Act).
  shipTo: z.object({
    name: z.string().trim().max(200).nullish(),
    gstin: z.string().trim().toUpperCase().max(15).nullish(),
    address: z.string().trim().max(500).nullish(),
    city: z.string().trim().max(60).nullish(),
    pincode: z.string().trim().nullish(),
    stateCode: z.string().length(2, 'Pick the ship-to state.'),
    thirdParty: z.boolean().optional(),
  }).nullish(),
  /** Priced in another currency: amounts in its minor unit, booked in rupees at the rate. */
  currency: z.string().trim().toUpperCase().length(3).optional(),
  /** Numbered in a voucher type's own series. */
  voucherTypeId: z.string().nullish(),
  /** The cost centre the document's income or expense belongs to. */
  costCentreId: z.union([z.string(), z.number()]).nullish(),
  warehouseId: z.union([z.string(), z.number()]).nullish(),
  exchangeRate: z.number().positive().optional(),
  overrideLimits: z.boolean().optional(),
  /** A debit note (CGST Act s.34(3)), the invoice it corrects, and why. */
  docKind: z.enum(['invoice', 'debit_note']).optional(),
  againstInvoiceId: z.union([z.string(), z.number()]).nullish(),
  noteReason: z.string().trim().max(255).nullish(),
  /** Billable expenses this invoice re-charges (their lines are on it); marked so they are not offered again. */
  billExpenseIds: z.array(z.union([z.string(), z.number()])).max(200).optional(),
  /** Paid at the counter: the receipt is recorded with the sale (a sales receipt). */
  paidAtSale: z.object({
    mode: z.enum(['cash', 'cheque', 'neft', 'rtgs', 'imps', 'upi', 'card', 'netbanking', 'other']),
    bankAccountId: z.union([z.string(), z.number()]),
    reference: z.string().trim().max(100).nullish(),
  }).nullish(),
  exportDetails: z.object({
    shippingBillNo: z.string().trim().max(20).nullish(),
    shippingBillDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    portCode: z.string().trim().toUpperCase().max(6).nullish(),
    countryCode: z.string().trim().toUpperCase().length(2).nullish(),
    currency: z.string().trim().toUpperCase().length(3).nullish(),
  }).nullish(),
});

export type InvoiceBody = z.infer<typeof CreateInput>;

/** The body as the sales service takes it. */
export function toInvoiceInput(input: InvoiceBody, role: RoleName | undefined): CreateInvoiceInput {
  return {
    branchId: Number(input.branchId),
    customerId: Number(input.customerId),
    date: input.date,
    dueDate: input.dueDate,
    placeOfSupply: input.placeOfSupply,
    supplyKind: input.supplyKind,
    exportWithTax: input.exportWithTax,
    status: input.status,
    number: input.number,
    orderNumber: input.orderNumber,
    subject: input.subject,
    paymentTerms: input.paymentTerms,
    salespersonId: input.salespersonId ? Number(input.salespersonId) : null,
    notes: input.notes,
    terms: input.terms,
    shippingChargePaise: input.shippingChargePaise,
    reverseCharge: input.reverseCharge,
    billOfSupply: input.billOfSupply,
    eco: input.eco ?? null,
    adjustmentPaise: input.adjustmentPaise,
    adjustmentLabel: input.adjustmentLabel,
    tcsCode: input.tcsCode ?? null,
    tcsPaise: input.tcsPaise,
    shipTo: input.shipTo ?? null,
    exportDetails: input.exportDetails ?? null,
    currency: input.currency,
    exchangeRate: input.exchangeRate,
    voucherTypeId: input.voucherTypeId ? Number(input.voucherTypeId) : null,
    costCentreId: input.costCentreId ? Number(input.costCentreId) : null,
    warehouseId: input.warehouseId ? Number(input.warehouseId) : null,
    // Past a blocked credit limit only for someone who may approve sales.
    overrideLimits: !!input.overrideLimits && hasPermission(role, 'sales', 'approve'),
    lines: input.lines.map((l) => ({
      itemId: l.itemId ? Number(l.itemId) : null,
      description: l.description,
      hsnSac: l.hsnSac,
      qty: l.qty,
      uqc: l.uqc,
      ratePaise: l.ratePaise,
      discountPct: l.discountPct,
      gstRatePct: l.gstRatePct,
      cessRatePct: l.cessRatePct,
      batchId: l.batchId ? Number(l.batchId) : null,
      serials: l.serials,
    })),
    lineSources: input.lines.some((l) => l.sourceLineId)
      ? input.lines.map((l) => (l.sourceLineType && l.sourceLineId ? { type: l.sourceLineType, id: Number(l.sourceLineId) } : null))
      : undefined,
    docKind: input.docKind,
    againstInvoiceId: input.againstInvoiceId ? Number(input.againstInvoiceId) : null,
    noteReason: input.noteReason ?? null,
  };
}
