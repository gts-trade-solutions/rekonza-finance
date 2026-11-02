import { db, transaction } from '@/lib/server/db';
import { route, badRequest, notFound, ApiError } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { logPortalActivity, openPortal, PORTAL_UPLOAD_FOLDER } from '@/lib/server/services/portal';
import { attachFile, MAX_FILE_BYTES } from '@/lib/server/files/attachments';
import { notify, usersWhoCan } from '@/lib/server/services/notifications';
import { bucket, count, overLimit } from '@/lib/server/auth/throttle';

const UPLOADS_PER_DAY = 50;

// A customer or vendor sending a file in from the portal — a vendor's bill, a
// customer's purchase order or remittance advice. It goes onto the contact's
// record, in the "From the portal" folder, and the team is told it is there.
export const POST = route(
  async ({ params, req }) => {
    const p = await openPortal(db, params.token ?? '');
    if (!p) throw notFound('This link has expired or been withdrawn.');
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw badRequest('Send the document as a file.');
    }
    const file = form.get('file');
    const note = String(form.get('note') ?? '').slice(0, 300);
    if (!(file instanceof File)) throw badRequest('Choose the file to send.');
    if (file.size > MAX_FILE_BYTES) throw badRequest(`Files can be up to ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
    // A day's uploads per contact: a link in the wrong hands cannot fill the business's storage.
    const daily = bucket('portal-upload', `${p.orgId}:${p.contactId}`);
    if (await overLimit(db, daily, UPLOADS_PER_DAY, 24 * 60)) throw new ApiError(429, `That is ${UPLOADS_PER_DAY} files today, the most one day allows. Send the rest tomorrow, or email them.`, 'rate_limited');
    await count(db, daily, 24 * 60);
    const contact = await db.selectFrom('contacts').select('display_name').where('id', '=', p.contactId).executeTakeFirstOrThrow();
    const bytes = Buffer.from(await file.arrayBuffer());
    const vendor = p.side === 'vendor';
    const a = await transaction(async (trx) => {
      const att = await attachFile(trx, p.orgId, null, {
        type: 'contact', targetId: p.contactId, filename: vendor ? `Vendor bill - ${file.name}` : file.name, bytes, folder: PORTAL_UPLOAD_FOLDER,
      });
      await logAudit({
        trx, orgId: p.orgId, actorUserId: null, actorName: `${contact.display_name} (portal)`, action: 'update',
        targetType: 'contact', targetId: p.contactId, detail: `${vendor ? 'Bill' : 'File'} sent in on the portal: ${file.name}${note ? ` — ${note}` : ''}`,
      });
      await logPortalActivity(trx, { ...p, action: 'uploaded', targetType: 'file', targetId: Number(att.id), detail: `Sent ${file.name}${note ? ` — ${note}` : ''}`, ip: auditMeta(req).ip });
      await notify(trx, p.orgId, await usersWhoCan(trx, p.orgId, vendor ? 'purchases' : 'sales', vendor ? 'create' : 'view'), {
        kind: 'portal', title: `${contact.display_name} sent ${vendor ? 'a bill' : 'a file'}`, body: note || file.name,
        href: vendor ? `/purchases/vendors/${p.contactId}` : `/sales/customers/${p.contactId}`,
      });
      return att;
    });
    return { received: a.filename };
  },
  { public: true },
);
