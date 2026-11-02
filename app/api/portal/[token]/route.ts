import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, notFound, badRequest } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import {
  answerQuote, logPortalActivity, openPortal, ownsInvoice, portalComment, portalOverview, PORTAL_COMMENT_TYPES,
  requestBankChange, respondToOrder, updatePortalProfile,
} from '@/lib/server/services/portal';
import { createPaymentLink } from '@/lib/server/services/payment-links';
import { notify, usersWhoCan } from '@/lib/server/services/notifications';

// The portal, for whoever holds a portal link (services/portal.ts) — opened
// from the business's email or by signing in with a code (/api/portal/login).
// The token is the key, and it opens one contact's records only.

const gone = () => notFound('This link has expired or been withdrawn. Ask for a new one, or sign in with your email.');

export const GET = route(
  async ({ params, req }) => {
    const p = await openPortal(db, params.token ?? '');
    if (!p) throw gone();
    // Opened, once per half hour at most, for the Portal activities report.
    const last = await db.selectFrom('portal_activity').select('created_at')
      .where('org_id', '=', p.orgId).where('contact_id', '=', p.contactId).where('action', '=', 'opened')
      .orderBy('created_at', 'desc').limit(1).executeTakeFirst();
    if (!last || Date.now() - new Date(last.created_at).getTime() > 30 * 60_000) {
      await logPortalActivity(db, { ...p, action: 'opened', detail: 'Opened the portal', ip: auditMeta(req).ip });
    }
    return portalOverview(db, p.orgId, p.contactId, p.side);
  },
  { public: true },
);

const ID = z.union([z.string(), z.number()]).transform(Number);
const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept'), estimateId: ID, note: z.string().trim().max(1000).optional() }),
  z.object({ action: z.literal('decline'), estimateId: ID, note: z.string().trim().max(1000).optional() }),
  z.object({ action: z.literal('pay'), invoiceId: ID }),
  z.object({ action: z.literal('comment'), targetType: z.enum(PORTAL_COMMENT_TYPES), targetId: ID, body: z.string().trim().min(1).max(2000) }),
  z.object({
    action: z.literal('profile'),
    email: z.string().trim().max(190).nullish(), phone: z.string().trim().max(30).nullish(),
    billingAddress: z.string().trim().max(500).nullish(), billingCity: z.string().trim().max(60).nullish(), billingPincode: z.string().trim().max(6).nullish(),
    shippingAddress: z.string().trim().max(500).nullish(), shippingCity: z.string().trim().max(60).nullish(), shippingPincode: z.string().trim().max(6).nullish(),
  }),
  z.object({ action: z.literal('bank-details'), bankName: z.string().trim().max(100), accountName: z.string().trim().max(150), accountNo: z.string().trim().max(30), ifsc: z.string().trim().max(11) }),
  z.object({ action: z.literal('order'), orderId: ID, decision: z.enum(['accepted', 'declined']), note: z.string().trim().max(500).optional() }),
]);

export const POST = route(
  async ({ params, req }) => {
    const p = await openPortal(db, params.token ?? '');
    if (!p) throw gone();
    const input = await body(req, Input);
    const ip = auditMeta(req).ip;
    const contact = await db.selectFrom('contacts').select('display_name').where('id', '=', p.contactId).executeTakeFirstOrThrow();
    const who = `${contact.display_name} (portal)`;
    const audit = (trx: Parameters<typeof logAudit>[0]['trx'], targetType: string, targetId: number, detail: string) =>
      logAudit({ trx, orgId: p.orgId, actorUserId: null, actorName: who, action: 'update', targetType, targetId, detail });

    if (input.action === 'pay') {
      if (p.side !== 'customer') throw badRequest('Only a customer pays from the portal.');
      if (!(await ownsInvoice(db, p.orgId, p.contactId, input.invoiceId))) throw notFound('That invoice is not yours.');
      const link = await transaction((trx) => createPaymentLink(trx, p.orgId, null, input.invoiceId));
      await logPortalActivity(db, { ...p, action: 'pay_started', targetType: 'invoice', targetId: input.invoiceId, detail: 'Started paying an invoice online', ip });
      return link;
    }

    if (input.action === 'comment') {
      return transaction(async (trx) => {
        const r = await portalComment(trx, p.orgId, p.contactId, p.side, contact.display_name, input);
        await logPortalActivity(trx, { ...p, action: 'commented', targetType: input.targetType, targetId: input.targetId, detail: `On ${r.label} ${r.number}: ${input.body.slice(0, 200)}`, ip });
        await notify(trx, p.orgId, await usersWhoCan(trx, p.orgId, p.side === 'customer' ? 'sales' : 'purchases', 'view'), {
          kind: 'portal', title: `${contact.display_name} commented on ${r.label} ${r.number}`, body: input.body.slice(0, 200),
          href: p.side === 'customer' ? `/sales/customers/${p.contactId}` : `/purchases/vendors/${p.contactId}`,
        });
        return { ok: true };
      });
    }

    if (input.action === 'profile') {
      const { action: _a, ...fields } = input;
      void _a;
      return transaction(async (trx) => {
        const r = await updatePortalProfile(trx, p.orgId, p.contactId, fields);
        if (r.changed.length) {
          await audit(trx, 'contact', p.contactId, `Updated on the portal: ${r.changed.join(', ')}`);
          await logPortalActivity(trx, { ...p, action: 'profile_updated', targetType: 'contact', targetId: p.contactId, detail: `Updated their ${r.changed.join(', ')}`, ip });
          await notify(trx, p.orgId, await usersWhoCan(trx, p.orgId, p.side === 'customer' ? 'sales' : 'purchases', 'edit'), {
            kind: 'portal', title: `${contact.display_name} updated their details`, body: r.changed.join(', '),
            href: p.side === 'customer' ? `/sales/customers/${p.contactId}` : `/purchases/vendors/${p.contactId}`,
          });
        }
        return r;
      });
    }

    if (input.action === 'bank-details') {
      if (p.side !== 'vendor') throw badRequest('Only a vendor gives bank details here.');
      return transaction(async (trx) => {
        const r = await requestBankChange(trx, p.orgId, p.contactId, input);
        await audit(trx, 'contact', p.contactId, `Asked on the portal to be paid into account ending ${r.accountLast4} (${input.ifsc}); waiting for approval`);
        await logPortalActivity(trx, { ...p, action: 'bank_change_requested', targetType: 'contact', targetId: p.contactId, detail: `Asked to be paid into an account ending ${r.accountLast4}`, ip });
        await notify(trx, p.orgId, await usersWhoCan(trx, p.orgId, 'purchases', 'edit'), {
          kind: 'portal', title: `${contact.display_name} asked to change their bank account`,
          body: `New account ending ${r.accountLast4}. Confirm it with them by phone before approving.`, href: `/purchases/vendors/${p.contactId}`,
        });
        return { pending: true, accountLast4: r.accountLast4 };
      });
    }

    if (input.action === 'order') {
      if (p.side !== 'vendor') throw badRequest('Only a vendor answers purchase orders.');
      return transaction(async (trx) => {
        const r = await respondToOrder(trx, p.orgId, p.contactId, input.orderId, input.decision, input.note);
        await audit(trx, 'purchase_order', input.orderId, `Purchase order ${r.number} ${input.decision} by the vendor on the portal${input.note ? `: ${input.note}` : ''}`);
        await logPortalActivity(trx, { ...p, action: `order_${input.decision}`, targetType: 'purchase_order', targetId: input.orderId, detail: `${input.decision === 'accepted' ? 'Accepted' : 'Declined'} purchase order ${r.number}${input.note ? `: ${input.note}` : ''}`, ip });
        await notify(trx, p.orgId, await usersWhoCan(trx, p.orgId, 'purchases', 'view'), {
          kind: 'portal', title: `${contact.display_name} ${input.decision} purchase order ${r.number}`, body: input.note || undefined, href: '/purchases/purchase-orders',
        });
        return { number: r.number, decision: input.decision };
      });
    }

    if (p.side !== 'customer') throw badRequest('Only a customer answers quotes.');
    const decision = input.action === 'accept' ? 'accepted' : 'declined';
    const r = await transaction(async (trx) => {
      const q = await answerQuote(trx, p.orgId, p.contactId, input.estimateId, decision);
      await logAudit({
        trx, orgId: p.orgId, actorUserId: null, actorName: who, action: 'update',
        targetType: 'estimate', targetId: input.estimateId, targetLabel: q.number, detail: `Quote ${decision} by the customer on the portal${input.note ? `: ${input.note}` : ''}`,
      });
      if (input.note) await portalComment(trx, p.orgId, p.contactId, 'customer', contact.display_name, { targetType: 'estimate', targetId: input.estimateId, body: input.note });
      await logPortalActivity(trx, { ...p, action: `quote_${decision}`, targetType: 'estimate', targetId: input.estimateId, detail: `${decision === 'accepted' ? 'Accepted' : 'Declined'} quote ${q.number}${input.note ? `: ${input.note}` : ''}`, ip });
      await notify(trx, p.orgId, await usersWhoCan(trx, p.orgId, 'sales', 'edit'), { kind: 'portal', title: `${contact.display_name} ${decision} quote ${q.number}`, body: input.note || undefined, href: '/sales/estimates' });
      return q;
    });
    return { number: r.number, status: decision };
  },
  { public: true },
);
