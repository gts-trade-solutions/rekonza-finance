import { z } from 'zod';
import { transaction } from '@/lib/server/db';
import { route, body, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { recordBulkPayments } from '@/lib/server/services/bulk-payments';

// Record bulk payments (services/bulk-payments.ts): many bills, or many
// invoices, paid at once, one payment per vendor or customer.

const Input = z.object({
  side: z.enum(['received', 'made']),
  branchId: z.union([z.string(), z.number()]).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Give the payment date.'),
  mode: z.enum(['cash', 'cheque', 'neft', 'rtgs', 'imps', 'upi', 'card', 'netbanking', 'other']),
  bankAccountId: z.union([z.string(), z.number()]).transform(Number),
  reference: z.string().trim().max(100).nullish(),
  rows: z.array(z.object({
    docId: z.union([z.string(), z.number()]).transform(Number),
    amountPaise: z.number().int().min(0),
    tdsPaise: z.number().int().min(0).optional(),
    reference: z.string().trim().max(100).nullish(),
  })).min(1, 'Pick at least one document.').max(500),
});

export const POST = route(async ({ orgId, user, role, branchId, req }) => {
  const input = await body(req, Input);
  const area = input.side === 'received' ? 'sales' : 'purchases';
  if (!hasPermission(role, area, 'create')) throw forbidden(`Your role cannot record ${input.side === 'received' ? 'receipts' : 'payments'}.`);
  return transaction(async (trx) => {
    const made = await recordBulkPayments(trx, orgId, user.userId, { ...input, branchId: Number(input.branchId ?? branchId) || branchId });
    await logAudit({
      trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'payment',
      detail: `Bulk ${input.side === 'received' ? 'receipts' : 'payments'}: ${made.map((m) => `${m.number} ${m.partyName} ₹${(m.amountPaise / 100).toFixed(2)} for ${m.documents} document(s)`).join('; ')}`,
      ...auditMeta(req),
    });
    return { payments: made.map((m) => ({ ...m, paymentId: String(m.paymentId), partyId: String(m.partyId) })) };
  });
}, { permission: { module: 'sales', action: 'view' } });
