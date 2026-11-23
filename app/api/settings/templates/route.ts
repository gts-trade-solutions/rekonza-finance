import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { formatTitle, INVOICE_FORMAT_LABEL, INVOICE_FORMATS, layoutForInvoice, readTemplate, templateInfo, TEMPLATE_DOCS, TEMPLATE_KEYS, type TemplateDoc, type TemplateKey } from '@/lib/print-template';

// ─────────────────────────────────────────────────────────────────────────────
// Settings → PDF Templates, as in Zoho Books: which of the twelve templates
// each kind of document prints in, the ones added to each kind's list, the
// theme colour, and whether the logo and the signature print.
//
// GET also returns the business as its documents print it (name, logo,
// address, GSTIN), so the gallery shows each template with the business's
// own heading rather than a stranger's.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(
  async ({ orgId, branchId }) => {
    const org = await db.selectFrom('organizations')
      .select(['name', 'legal_name', 'pan', 'email', 'phone', 'logo_file_id', 'print_template', 'signatory_name'])
      .where('id', '=', orgId).executeTakeFirstOrThrow();
    // The branch the user works at, or the head office: whichever prints on their documents.
    const branch = await db.selectFrom('branches').select(['gstin', 'address', 'city', 'pincode', 'state_code'])
      .where('org_id', '=', orgId)
      .$if(!!branchId, (q) => q.where('id', '=', Number(branchId)))
      .orderBy('is_primary', 'desc').orderBy('id')
      .executeTakeFirst();
    return {
      template: readTemplate(org.print_template),
      business: {
        orgId: String(orgId),
        name: org.legal_name || org.name,
        logoUrl: org.logo_file_id ? `/api/files/${org.logo_file_id}` : null,
        logoFileId: org.logo_file_id ? String(org.logo_file_id) : null,
        address: branch?.address ?? null,
        city: branch?.city ?? null,
        pincode: branch?.pincode ?? null,
        stateCode: branch?.state_code ?? null,
        gstin: branch?.gstin ?? null,
        pan: org.pan,
        email: org.email,
        phone: org.phone,
        signatoryName: org.signatory_name,
      },
    };
  },
  { permission: { module: 'settings', action: 'view' } },
);

const Key = z.enum(TEMPLATE_KEYS);

const TemplateInput = z.object({
  layout: Key,
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Pick a colour.').nullable(),
  showLogo: z.boolean(),
  showSignature: z.boolean(),
  footer: z.string().trim().max(300).nullish().transform((v) => v || null),
  byDoc: z.record(z.string(), Key).default({}),
  added: z.record(z.string(), z.array(Key).max(12)).default({}),
  // Goods, services and export invoices: each format's template and title.
  byFormat: z.partialRecord(z.enum(INVOICE_FORMATS), Key).default({}),
  titles: z.partialRecord(z.enum(INVOICE_FORMATS), z.string().trim().max(60)).default({}),
});

export const PUT = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, z.object({ template: TemplateInput }));
    const before = await db.selectFrom('organizations').select('print_template').where('id', '=', orgId).executeTakeFirstOrThrow();
    const old = readTemplate(before.print_template);
    const next = readTemplate(input.template);
    // A short line for the audit trail: what changed, in Zoho's names.
    const changes: string[] = [];
    for (const doc of TEMPLATE_DOCS as readonly TemplateDoc[]) {
      const a: TemplateKey = old.byDoc[doc] ?? old.layout;
      const b: TemplateKey = next.byDoc[doc] ?? next.layout;
      if (a !== b) changes.push(`${doc}: ${templateInfo(a).name} → ${templateInfo(b).name}`);
    }
    for (const f of INVOICE_FORMATS) {
      const a = layoutForInvoice(old, f);
      const b = layoutForInvoice(next, f);
      if (a !== b) changes.push(`${INVOICE_FORMAT_LABEL[f]}: ${templateInfo(a).name} → ${templateInfo(b).name}`);
      if (formatTitle(old, f) !== formatTitle(next, f)) changes.push(`${INVOICE_FORMAT_LABEL[f]} title "${formatTitle(old, f)}" → "${formatTitle(next, f)}"`);
    }
    if (old.accent !== next.accent) changes.push(`colour ${old.accent ?? 'template'} → ${next.accent ?? 'template'}`);
    if (old.showLogo !== next.showLogo) changes.push(next.showLogo ? 'logo on' : 'logo off');
    if (old.showSignature !== next.showSignature) changes.push(next.showSignature ? 'signature on' : 'signature off');
    if (old.footer !== next.footer) changes.push('footer line');

    await transaction(async (trx) => {
      await trx.updateTable('organizations').set({ print_template: JSON.stringify(next) }).where('id', '=', orgId).execute();
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: 'organization', targetId: orgId,
        detail: `PDF templates: ${changes.join('; ') || 'templates added to the list'}`,
        payload: { template: next }, ...auditMeta(req),
      });
    });
    return { template: next };
  },
  { permission: { module: 'settings', action: 'edit' } },
);
