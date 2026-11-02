import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { siteUrl } from '@/lib/server/mail/mailer';
import { createPaymentLink, gatewayStatus, saveGateway } from '@/lib/server/services/payment-links';

// Online payments: whether this company's Razorpay is connected, connecting
// it, and a payment link for an invoice (services/payment-links.ts).

export const GET = route(async ({ orgId, req }) => {
  const s = await gatewayStatus(db, orgId);
  return { ...s, webhookUrl: `${siteUrl(req)}/api/payments/razorpay/${orgId}` };
});

const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('link'), invoiceId: z.union([z.string(), z.number()]) }),
  z.object({
    action: z.literal('connect'), keyId: z.string().trim().max(60), keySecret: z.string().trim().max(200),
    webhookSecret: z.string().trim().max(200), depositBankAccountId: z.union([z.string(), z.number()]),
  }),
]);

export const POST = route(async ({ orgId, user, role, req }) => {
  const input = await body(req, Input);
  if (input.action === 'connect') {
    if (!hasPermission(role, 'settings', 'edit')) throw forbidden('Only an admin can connect online payments.');
    await transaction(async (trx) => {
      await saveGateway(trx, orgId, { ...input, depositBankAccountId: Number(input.depositBankAccountId) });
      await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'integration', detail: `Razorpay connected (${input.keyId})`, ...auditMeta(req) });
    });
    return gatewayStatus(db, orgId);
  }
  if (!hasPermission(role, 'sales', 'export')) throw forbidden('You cannot send invoices to customers.');
  const r = await transaction((trx) => createPaymentLink(trx, orgId, user.userId, Number(input.invoiceId)));
  if (!r.reused) await logAudit({ orgId, actorUserId: user.userId, actorName: user.name, action: 'send', targetType: 'invoice', targetId: Number(input.invoiceId), detail: `Payment link for ₹${(r.amountPaise / 100).toFixed(2)}`, ...auditMeta(req) });
  return r;
});
