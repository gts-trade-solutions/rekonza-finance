import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import {
  addLowerCertificate, cancelLowerCertificate, certificates, listLowerCertificates, recordCertificate, setPanStatus,
} from '@/lib/server/tax/tds-certificates';
import type { Quarter } from '@/lib/server/tax/tds-returns';

// ─────────────────────────────────────────────────────────────────────────────
// Around the TDS return: the certificates sent to deductees and received from
// customers, lower-deduction certificates vendors hold, and whether each
// deductee's PAN is operative. See lib/server/tax/tds-certificates.ts.
// ─────────────────────────────────────────────────────────────────────────────

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.');
const currentFy = () => {
  const d = new Date();
  return d.getFullYear() - (d.getMonth() < 3 ? 1 : 0);
};

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({
      view: z.enum(['certificates', 'lower', 'pans']).default('certificates'),
      fy: z.coerce.number().int().min(2017).max(2100).optional(),
      quarter: z.coerce.number().int().min(1).max(4).optional(),
    }));
    if (q.view === 'lower') {
      const rows = await listLowerCertificates(db, orgId);
      return { certificates: rows.map((r) => ({ ...r, id: asId(r.id), contactId: asId(r.contactId) })) };
    }
    if (q.view === 'pans') {
      // Everyone TDS is deducted from: mapped to a section, or deducted on a bill.
      const rows = await db.selectFrom('contacts as c')
        .select(['c.id', 'c.display_name', 'c.pan', 'c.pan_status', 'c.pan_checked_on', 'c.tds_section'])
        .where('c.org_id', '=', orgId).where('c.is_archived', '=', 0)
        .where((eb) => eb.or([
          eb('c.tds_section', 'is not', null),
          eb.exists(eb.selectFrom('bills as b').select('b.id').whereRef('b.vendor_id', '=', 'c.id').where('b.tds_amount', '>', '0')),
        ]))
        .orderBy('c.display_name').execute();
      return {
        deductees: rows.map((r) => ({
          id: asId(r.id), name: r.display_name, pan: r.pan, panStatus: r.pan_status,
          checkedOn: r.pan_checked_on ? String(r.pan_checked_on).slice(0, 10) : null, section: r.tds_section,
        })),
      };
    }
    return certificates(db, orgId, q.fy ?? currentFy(), (q.quarter ?? 1) as Quarter);
  },
  { permission: { module: 'gst', action: 'view' } },
);

const Input = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('lower-add'),
    contactId: z.union([z.string(), z.number()]),
    sectionCode: z.string().trim().min(1).max(10),
    certificateNo: z.string().trim().min(6).max(20),
    ratePct: z.number().min(0).max(100),
    validFrom: DATE,
    validTo: DATE,
    limitPaise: z.number().int().positive().nullish(),
    notes: z.string().trim().max(300).nullish(),
  }),
  z.object({ action: z.literal('lower-cancel'), id: z.union([z.string(), z.number()]) }),
  z.object({
    action: z.literal('certificate'),
    direction: z.enum(['issued', 'received']),
    contactId: z.union([z.string(), z.number()]),
    fy: z.number().int().min(2017).max(2100),
    quarter: z.number().int().min(1).max(4),
    certificateNo: z.string().trim().min(4).max(30),
    issuedOn: DATE,
    taxPaise: z.number().int().min(0),
    fileId: z.union([z.string(), z.number()]).nullish(),
    notes: z.string().trim().max(300).nullish(),
  }),
  z.object({
    action: z.literal('pan-status'),
    contactId: z.union([z.string(), z.number()]),
    status: z.enum(['operative', 'inoperative', 'unverified']),
    checkedOn: DATE,
  }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    const audit = (action: 'create' | 'update' | 'void', targetType: string, targetId: number, label: string, detail: string) => ({
      orgId, actorUserId: user.userId, actorName: user.name, action, targetType, targetId, targetLabel: label, detail, ...auditMeta(req),
    });

    return transaction(async (trx) => {
      switch (input.action) {
        case 'lower-add': {
          const r = await addLowerCertificate(trx, orgId, user.userId, {
            contactId: Number(input.contactId), sectionCode: input.sectionCode, certificateNo: input.certificateNo,
            ratePct: input.ratePct, validFrom: input.validFrom, validTo: input.validTo, limitPaise: input.limitPaise ?? null,
            notes: input.notes,
          });
          await logAudit({ trx, ...audit('create', 'tds_lower_certificate', r.id, r.certificateNo,
            `${input.sectionCode} at ${input.ratePct}% from ${input.validFrom} to ${input.validTo}`) });
          return { id: asId(r.id) };
        }
        case 'lower-cancel': {
          await cancelLowerCertificate(trx, orgId, Number(input.id));
          await logAudit({ trx, ...audit('void', 'tds_lower_certificate', Number(input.id), String(input.id), 'Withdrawn') });
          return { ok: true };
        }
        case 'certificate': {
          const r = await recordCertificate(trx, orgId, user.userId, {
            direction: input.direction, contactId: Number(input.contactId), fy: input.fy, quarter: input.quarter as Quarter,
            certificateNo: input.certificateNo, issuedOn: input.issuedOn, taxPaise: input.taxPaise,
            fileId: input.fileId ? Number(input.fileId) : null, notes: input.notes,
          });
          await logAudit({ trx, ...audit('create', 'tds_certificate', r.id, input.certificateNo,
            `${input.direction === 'issued' ? 'Sent' : 'Received'} for FY ${input.fy} Q${input.quarter}, tax ₹${(input.taxPaise / 100).toFixed(2)}`) });
          return { id: asId(r.id) };
        }
        case 'pan-status': {
          await setPanStatus(trx, orgId, Number(input.contactId), input.status, input.checkedOn);
          await logAudit({ trx, ...audit('update', 'contact', Number(input.contactId), String(input.contactId),
            `PAN ${input.status} as checked on ${input.checkedOn}`) });
          return { ok: true };
        }
      }
    });
  },
  { permission: { module: 'gst', action: 'create' } },
);
