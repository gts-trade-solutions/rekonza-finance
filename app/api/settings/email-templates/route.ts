import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { EMAIL_KINDS, EMAIL_SPECS, listTemplates, resetTemplate, saveTemplate, type EmailKind } from '@/lib/server/mail/templates';

// The wording of the emails the books send (lib/server/mail/templates.ts).

export const GET = route(
  async ({ orgId }) => ({ templates: await listTemplates(db, orgId) }),
  { permission: { module: 'settings', action: 'view' } },
);

const Kind = z.enum(EMAIL_KINDS as [EmailKind, ...EmailKind[]]);
const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), kind: Kind, subject: z.string().max(300), body: z.string().max(5000) }),
  z.object({ action: z.literal('reset'), kind: Kind }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    const label = EMAIL_SPECS[input.kind].label;
    await transaction(async (trx) => {
      if (input.action === 'reset') await resetTemplate(trx, orgId, input.kind);
      else await saveTemplate(trx, orgId, user.userId, input.kind, { subject: input.subject, body: input.body });
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'email_template', targetId: null, targetLabel: label,
        detail: input.action === 'reset' ? `${label} email put back to the built-in wording` : `${label} email wording changed`, ...auditMeta(req),
      });
    });
    return { templates: await listTemplates(db, orgId) };
  },
  { permission: { module: 'settings', action: 'edit' } },
);
