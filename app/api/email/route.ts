import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, body, query, asId, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { documentRecipients, mailStatus, siteUrl } from '@/lib/server/mail/mailer';
import { cancelScheduledEmail, scheduleInvoiceEmail, scheduledInvoiceEmails } from '@/lib/server/services/scheduled-email';
import { emailDocument, emailInvoice, emailStatement } from '@/lib/server/mail/documents';
import { PRINT_KINDS, PRINT_NOUN, PRINT_SIDE, type PrintKind } from '@/lib/print-doc';

// Emailing documents (lib/server/mail): whether mail is set up, what was sent
// about a document, and sending an invoice, any other document (a quote, an
// order, a receipt …) or a statement.

export const GET = route(async ({ orgId, req }) => {
  const q = query(req, z.object({ docType: z.string().max(30).optional(), docId: z.coerce.number().int().positive().optional() }));
  const status = mailStatus();
  let log = db.selectFrom('email_log').select(['id', 'doc_type', 'doc_id', 'to_address', 'subject', 'status', 'error', 'created_at'])
    .where('org_id', '=', orgId);
  if (q.docType) log = log.where('doc_type', '=', q.docType);
  if (q.docId) log = log.where('doc_id', '=', q.docId);
  const rows = await log.orderBy('id', 'desc').limit(q.docId ? 50 : 200).execute();
  // For an invoice's Send Email window: who it goes to by default, and what is waiting to go.
  let recipients: string[] | undefined;
  let scheduled: Awaited<ReturnType<typeof scheduledInvoiceEmails>> | undefined;
  if (q.docType === 'invoice' && q.docId) {
    const inv = await db.selectFrom('invoices').select('customer_id').where('id', '=', q.docId).where('org_id', '=', orgId).executeTakeFirst();
    if (inv) {
      recipients = await documentRecipients(db, orgId, inv.customer_id);
      scheduled = await scheduledInvoiceEmails(db, orgId, q.docId);
    }
  }
  return {
    configured: status.configured,
    from: status.from,
    ...(recipients ? { recipients, scheduled } : {}),
    sent: rows.map((r) => ({
      id: asId(r.id), docType: r.doc_type, docId: r.doc_id ? asId(r.doc_id) : null, to: r.to_address, subject: r.subject,
      status: r.status, error: r.error, at: new Date(r.created_at).toISOString(),
    })),
  };
});

const emails = z.array(z.string().trim().email('That email address does not look right.')).max(20).optional();
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const SendInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('invoice'), invoiceId: z.union([z.string(), z.number()]), to: emails, cc: emails, message: z.string().max(2000).nullish(),
    /** Zoho's Schedule Email: send at this moment instead of now (ISO date-time). */
    at: z.string().datetime({ offset: true }).optional(),
  }),
  z.object({
    kind: z.literal('document'), docKind: z.enum(PRINT_KINDS as [PrintKind, ...PrintKind[]]), id: z.union([z.string(), z.number()]),
    to: emails, cc: emails, message: z.string().max(2000).nullish(), proforma: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('statement'), contactId: z.union([z.string(), z.number()]), side: z.enum(['customer', 'vendor']),
    from: DATE, to: DATE, recipients: emails, cc: emails, message: z.string().max(2000).nullish(),
  }),
]);

export const POST = route(async ({ orgId, user, role, req }) => {
  const input = await body(req, SendInput);
  const baseUrl = siteUrl(req);
  if (input.kind === 'invoice') {
    if (!hasPermission(role, 'sales', 'create')) throw forbidden('You cannot send invoices.');
    if (input.at) {
      const s = await scheduleInvoiceEmail(db, orgId, user.userId, Number(input.invoiceId), new Date(input.at), { to: input.to, cc: input.cc, message: input.message, baseUrl });
      await logAudit({ orgId, actorUserId: user.userId, actorName: user.name, action: 'send', targetType: 'invoice', targetId: Number(input.invoiceId), detail: `Email scheduled for ${s.at}${s.to.length ? ` to ${s.to.join(', ')}` : ''}`, ...auditMeta(req) });
      return { scheduled: s };
    }
    const r = await emailInvoice(orgId, user.userId, Number(input.invoiceId), { to: input.to, cc: input.cc, message: input.message, baseUrl });
    await logAudit({ orgId, actorUserId: user.userId, actorName: user.name, action: 'send', targetType: 'invoice', targetId: Number(input.invoiceId), detail: `Emailed to ${r.to.join(', ')}`, ...auditMeta(req) });
    return { to: r.to };
  }
  if (input.kind === 'document') {
    const area = PRINT_SIDE[input.docKind] === 'customer' ? 'sales' : 'purchases';
    if (!hasPermission(role, area, 'create')) throw forbidden(`You cannot send documents in ${area}.`);
    const proforma = input.docKind === 'sales-order' && !!input.proforma;
    const r = await emailDocument(orgId, user.userId, input.docKind, Number(input.id), { to: input.to, cc: input.cc, message: input.message, baseUrl, proforma });
    await logAudit({ orgId, actorUserId: user.userId, actorName: user.name, action: 'send', targetType: input.docKind, targetId: Number(input.id), detail: `${proforma ? 'proforma invoice' : PRINT_NOUN[input.docKind]} emailed to ${r.to.join(', ')}`, ...auditMeta(req) });
    return { to: r.to };
  }
  if (!hasPermission(role, input.side === 'customer' ? 'sales' : 'purchases', 'view')) throw forbidden('You cannot see that account.');
  const r = await emailStatement(orgId, user.userId, Number(input.contactId), input.side, input.from, input.to, { to: input.recipients, cc: input.cc, message: input.message, baseUrl });
  await logAudit({ orgId, actorUserId: user.userId, actorName: user.name, action: 'send', targetType: 'contact', targetId: Number(input.contactId), detail: `Statement ${input.from} to ${input.to} emailed to ${r.to.join(', ')}`, ...auditMeta(req) });
  return { to: r.to };
});

/** Call off a scheduled invoice email (?scheduledId=) that has not gone yet. */
export const DELETE = route(async ({ orgId, user, role, req }) => {
  if (!hasPermission(role, 'sales', 'create')) throw forbidden('You cannot change what is sent.');
  const q = query(req, z.object({ scheduledId: z.coerce.number().int().positive() }));
  const r = await cancelScheduledEmail(db, orgId, q.scheduledId);
  await logAudit({ orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'invoice', targetId: r.invoiceId, detail: 'Scheduled email called off', ...auditMeta(req) });
  return { cancelled: true };
});
