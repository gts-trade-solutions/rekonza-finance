import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, forbidden, badRequest } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { mailStatus, sendMail, siteUrl } from '@/lib/server/mail/mailer';
import {
  contactPortalComments, createPortalLink, decidePortalRequest, listPortalLinks, listPortalRequests, PORTAL_COMMENT_TYPES, PORTAL_SHARED_FOLDER,
  PORTAL_UPLOAD_FOLDER, replyOnPortal, revokePortalLinks,
} from '@/lib/server/services/portal';
import { attachFile, MAX_FILE_BYTES } from '@/lib/server/files/attachments';
import { renderEmail } from '@/lib/server/mail/templates';

// Giving a customer or vendor access to their portal, and taking it away; the
// files shared on it, what they did there, and approving what they asked for
// (a vendor's new bank account).

const moduleOf = (side: 'customer' | 'vendor') => (side === 'customer' ? 'sales' : 'purchases');

export const GET = route(async ({ orgId, role, req }) => {
  if (!hasPermission(role, 'sales', 'view') && !hasPermission(role, 'purchases', 'view')) throw forbidden('You cannot see contacts.');
  const { contactId, side } = query(req, z.object({ contactId: z.coerce.number().int().positive(), side: z.enum(['customer', 'vendor']).optional() }));
  const [links, requests, files, activity, comments] = await Promise.all([
    listPortalLinks(db, orgId, contactId),
    listPortalRequests(db, orgId, contactId),
    db.selectFrom('files').select(['id', 'filename', 'size_bytes', 'folder', 'created_at'])
      .where('org_id', '=', orgId).where('attached_to_type', '=', 'contact').where('attached_to_id', '=', contactId)
      .where('deleted_at', 'is', null).where('folder', 'in', [PORTAL_SHARED_FOLDER, PORTAL_UPLOAD_FOLDER]).orderBy('created_at', 'desc').limit(50).execute(),
    db.selectFrom('portal_activity').select(['action', 'detail', 'created_at']).where('org_id', '=', orgId).where('contact_id', '=', contactId)
      .orderBy('created_at', 'desc').limit(8).execute(),
    side && hasPermission(role, moduleOf(side), 'view') ? contactPortalComments(db, orgId, contactId, side) : Promise.resolve([]),
  ]);
  return {
    links, requests, comments, mail: mailStatus().configured,
    files: files.map((f) => ({ id: String(f.id), filename: f.filename, sizeBytes: Number(f.size_bytes), shared: f.folder === PORTAL_SHARED_FOLDER, at: new Date(f.created_at).toISOString() })),
    activity: activity.map((a) => ({ action: a.action, detail: a.detail, at: new Date(a.created_at).toISOString() })),
  };
});

const Input = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'), contactId: z.union([z.string(), z.number()]), side: z.enum(['customer', 'vendor']),
    days: z.number().int().min(1).max(365).optional(), emailTo: z.string().trim().email().nullish(),
  }),
  z.object({ action: z.literal('revoke'), contactId: z.union([z.string(), z.number()]), side: z.enum(['customer', 'vendor']) }),
  // Approving a vendor's new bank account writes it to their record; it is never applied from the portal.
  z.object({
    action: z.literal('decide'), contactId: z.union([z.string(), z.number()]), side: z.enum(['customer', 'vendor']),
    requestId: z.union([z.string(), z.number()]), decision: z.enum(['applied', 'rejected']),
  }),
  // Taking a file off the portal: it stays on the contact, out of the shared folder.
  z.object({ action: z.literal('unshare'), contactId: z.union([z.string(), z.number()]), side: z.enum(['customer', 'vendor']), fileId: z.union([z.string(), z.number()]) }),
  // Answering a comment they left on one of their documents.
  z.object({
    action: z.literal('reply'), contactId: z.union([z.string(), z.number()]), side: z.enum(['customer', 'vendor']),
    targetType: z.enum(PORTAL_COMMENT_TYPES), targetId: z.union([z.string(), z.number()]), body: z.string().trim().min(1).max(2000),
  }),
]);

const sideOf = z.enum(['customer', 'vendor']);

export const POST = route(async ({ orgId, user, role, req }) => {
  // Sharing a file on the portal: a form upload onto the contact, in the shared folder.
  if (req.headers.get('content-type')?.startsWith('multipart/form-data')) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw badRequest('Send the file as a form upload.');
    }
    const side = sideOf.parse(form.get('side'));
    const contactId = z.coerce.number().int().positive().parse(form.get('contactId'));
    if (!hasPermission(role, moduleOf(side), 'edit')) throw forbidden('You cannot share files on the portal.');
    const file = form.get('file');
    if (!(file instanceof File)) throw badRequest('Choose a file to share.');
    if (file.size > MAX_FILE_BYTES) throw badRequest(`Files can be up to ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
    const bytes = Buffer.from(await file.arrayBuffer());
    const a = await transaction(async (trx) => {
      const att = await attachFile(trx, orgId, user.userId, { type: 'contact', targetId: contactId, filename: file.name, bytes, folder: PORTAL_SHARED_FOLDER });
      await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'contact', targetId: contactId, detail: `Shared ${att.filename} on the portal`, ...auditMeta(req) });
      return att;
    });
    return { shared: a.filename };
  }

  const input = await body(req, Input);
  if (!hasPermission(role, moduleOf(input.side), 'edit')) throw forbidden('You cannot change portal access.');
  const contactId = Number(input.contactId);
  if (input.action === 'decide') {
    return transaction(async (trx) => {
      const r = await decidePortalRequest(trx, orgId, user.userId, Number(input.requestId), input.decision);
      if (r.contactId !== contactId) throw badRequest('That request is for another contact.');
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'contact', targetId: contactId,
        detail: r.kind === 'email'
          ? (input.decision === 'applied' ? `Approved the new email ${r.email}, asked for on the portal` : `Turned down the request, on the portal, to change the email to ${r.email}`)
          : input.decision === 'applied'
            ? `Approved the vendor's new bank account ending ${r.accountLast4}, asked for on the portal`
            : `Turned down the vendor's request, on the portal, to be paid into an account ending ${r.accountLast4}`,
        ...auditMeta(req),
      });
      return { decision: input.decision };
    });
  }
  if (input.action === 'reply') {
    return transaction(async (trx) => {
      const r = await replyOnPortal(trx, orgId, contactId, input.side, user, { targetType: input.targetType, targetId: Number(input.targetId), body: input.body });
      await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: input.targetType, targetId: Number(input.targetId), targetLabel: r.number, detail: `Replied on the portal: ${input.body.slice(0, 200)}`, ...auditMeta(req) });
      return { ok: true };
    });
  }
  if (input.action === 'unshare') {
    return transaction(async (trx) => {
      const f = await trx.selectFrom('files').select(['id', 'filename']).where('id', '=', Number(input.fileId)).where('org_id', '=', orgId)
        .where('attached_to_type', '=', 'contact').where('attached_to_id', '=', contactId).where('folder', '=', PORTAL_SHARED_FOLDER).executeTakeFirst();
      if (!f) throw badRequest('That file is not shared on this portal.');
      await trx.updateTable('files').set({ folder: null }).where('id', '=', f.id).execute();
      await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'contact', targetId: contactId, detail: `Took ${f.filename} off the portal (kept on the contact)`, ...auditMeta(req) });
      return { ok: true };
    });
  }
  if (input.action === 'revoke') {
    const n = await transaction(async (trx) => {
      const k = await revokePortalLinks(trx, orgId, contactId);
      await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'contact', targetId: contactId, detail: `Portal access withdrawn (${k} link${k === 1 ? '' : 's'})`, ...auditMeta(req) });
      return k;
    });
    return { revoked: n };
  }
  const link = await transaction(async (trx) => {
    const l = await createPortalLink(trx, orgId, user.userId, { contactId, side: input.side, days: input.days, email: input.emailTo });
    await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'contact', targetId: contactId, detail: `Portal access given, until ${l.expiresAt.slice(0, 10)}`, ...auditMeta(req) });
    return l;
  });
  const url = `${siteUrl(req)}${link.path}`;
  let emailed = false;
  if (input.emailTo && mailStatus().configured) {
    const org = await db.selectFrom('organizations').select(['name', 'legal_name', 'email']).where('id', '=', orgId).executeTakeFirstOrThrow();
    const contact = await db.selectFrom('contacts').select('display_name').where('id', '=', contactId).where('org_id', '=', orgId).executeTakeFirstOrThrow();
    const name = org.legal_name || org.name;
    const what = input.side === 'customer'
      ? 'You can see your invoices with us, pay them, answer our quotes and read your statement here:'
      : 'You can see our purchase orders, your bills and our payments, read your statement and send us your bills here:';
    // In the business's own wording (mail/templates.ts).
    const mail = await renderEmail(db, orgId, 'portal_invite', { contact: contact.display_name, what, link: url, expires: link.expiresAt.slice(0, 10), business: name });
    await sendMail(orgId, {
      to: [input.emailTo], subject: mail.subject, replyTo: org.email, fromName: name, text: mail.text,
    }, { docType: 'portal', docId: contactId, userId: user.userId });
    emailed = true;
  }
  return { url, expiresAt: link.expiresAt, emailed };
});
