import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { encryptionConfigured } from '@/lib/server/crypto/fields';
import {
  closeRequest, contactData, eraseContact, getPrivacySettings, listBreaches, listRequests, logBreach, logRequest,
  markBreach, retainedUntil, setPrivacySettings,
} from '@/lib/server/services/privacy';

// Personal data under the DPDP Act: settings, requests, breaches, and acting on
// a request — a party's data to hand over, or erased as far as the law allows.

export const GET = route(
  async ({ orgId }) => {
    const [settings, requests, breaches] = await Promise.all([getPrivacySettings(db, orgId), listRequests(db, orgId), listBreaches(db, orgId)]);
    return { settings, requests, breaches, encryptionAtRest: encryptionConfigured() };
  },
  { permission: { module: 'settings', action: 'view' } },
);

const Id = z.union([z.string(), z.number()]).transform(Number);
const Input = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('settings'),
    grievanceOfficer: z.object({ name: z.string().max(100), email: z.string().max(150), phone: z.string().max(20) }).optional(),
    retentionYears: z.number().int().optional(), responseDays: z.number().int().optional(),
  }),
  z.object({
    action: z.literal('log-request'), subjectType: z.enum(['contact', 'employee', 'user', 'other']), subjectId: Id.nullish(),
    subjectName: z.string().trim().min(1, 'Who is asking?').max(200), kind: z.enum(['access', 'correction', 'erasure', 'grievance', 'consent_withdrawal']),
    details: z.string().max(1000).nullish(), receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  z.object({ action: z.literal('close-request'), id: Id, status: z.enum(['done', 'refused']), response: z.string().max(2000) }),
  z.object({ action: z.literal('contact-data'), contactId: Id }),
  z.object({ action: z.literal('erase-contact'), contactId: Id }),
  z.object({
    action: z.literal('log-breach'), discoveredAt: z.string().min(10), description: z.string().max(2000),
    dataAffected: z.string().max(500).nullish(), peopleAffected: z.number().int().nonnegative().nullish(), measures: z.string().max(2000).nullish(),
  }),
  z.object({ action: z.literal('mark-breach'), id: Id, step: z.enum(['board_informed', 'board_report', 'people_informed']) }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    const meta = auditMeta(req);
    return transaction(async (trx) => {
      const audit = (targetType: string, targetId: number, detail: string) => logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType, targetId, detail, ...meta,
      });
      switch (input.action) {
        case 'settings': {
          const saved = await setPrivacySettings(trx, orgId, user.userId, {
            grievanceOfficer: input.grievanceOfficer, retentionYears: input.retentionYears, responseDays: input.responseDays,
          });
          await audit('organization', orgId, 'Privacy settings changed');
          return saved;
        }
        case 'log-request': {
          const r = await logRequest(trx, orgId, user.userId, input);
          await audit('privacy_request', r.id, `${input.kind.replace('_', ' ')} request from ${input.subjectName}, due ${r.dueOn}`);
          return { id: asId(r.id), dueOn: r.dueOn };
        }
        case 'close-request':
          await closeRequest(trx, orgId, user.userId, input.id, input);
          await audit('privacy_request', input.id, `Request ${input.status}: ${input.response.slice(0, 200)}`);
          return { id: asId(input.id) };
        case 'contact-data': {
          const data = await contactData(trx, orgId, input.contactId);
          await audit('contact', input.contactId, 'Personal data exported for a request to see it');
          return { ...data, keptUntil: await retainedUntil(trx, orgId, input.contactId) };
        }
        case 'erase-contact': {
          const r = await eraseContact(trx, orgId, input.contactId);
          await audit('contact', input.contactId, r.full
            ? 'Erased: name and every identifying detail removed; documents kept under an anonymous name'
            : `Contact details erased; name and address kept with the documents until ${r.keptUntil}, as the tax laws require`);
          return r;
        }
        case 'log-breach': {
          const id = await logBreach(trx, orgId, user.userId, input);
          await audit('privacy_breach', id, `Breach logged: ${input.description.slice(0, 200)}`);
          return { id: asId(id) };
        }
        case 'mark-breach':
          await markBreach(trx, orgId, input.id, input.step);
          await audit('privacy_breach', input.id, `Breach: ${input.step.replace('_', ' ')}`);
          return { id: asId(input.id) };
      }
    });
  },
  { permission: { module: 'settings', action: 'edit' } },
);
