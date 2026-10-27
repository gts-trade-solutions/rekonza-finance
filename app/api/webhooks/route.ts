import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import {
  deleteWebhook, deliverDueWebhooks, EVENT_TYPES, listWebhooks, queueEvent, revealSecret, saveWebhook,
} from '@/lib/server/integrations/webhooks';

// Webhooks: where to tell other software that something happened.

export const GET = route(
  async ({ orgId }) => ({ webhooks: await listWebhooks(db, orgId), eventTypes: EVENT_TYPES }),
  { permission: { module: 'settings', action: 'edit' } },
);

const Id = z.union([z.string(), z.number()]).transform(Number);
const Input = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'), id: Id.nullish(), url: z.string().trim().max(500), events: z.array(z.string().max(60)).min(1),
    description: z.string().max(200).nullish(), isActive: z.boolean().optional(),
  }),
  z.object({ action: z.literal('delete'), id: Id }),
  z.object({ action: z.literal('secret'), id: Id }),
  z.object({ action: z.literal('test'), id: Id }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    const audit = (id: number, detail: string) => logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'webhook', targetId: id, detail, ...auditMeta(req),
    });
    if (input.action === 'secret') {
      await audit(input.id, 'Signing secret shown');
      return { secret: await revealSecret(db, orgId, input.id) };
    }
    if (input.action === 'test') {
      await transaction((trx) => queueEvent(trx, orgId, 'webhook.test', {
        type: 'webhook', id: String(input.id), label: 'Test event', detail: `Sent by ${user.name} from Settings`, actor: user.name,
      }, input.id));
      // Sent now rather than on the next tick, so the result is on screen.
      await deliverDueWebhooks(5);
      return { ok: true };
    }
    return transaction(async (trx) => {
      if (input.action === 'delete') {
        await deleteWebhook(trx, orgId, input.id);
        await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'void', targetType: 'webhook', targetId: input.id, detail: 'Webhook deleted', ...auditMeta(req) });
        return { id: asId(input.id) };
      }
      const saved = await saveWebhook(trx, orgId, user.userId, { ...input, id: input.id ?? null });
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: input.id ? 'update' : 'create', targetType: 'webhook', targetId: saved.id,
        detail: `Webhook to ${input.url} for ${input.events.join(', ')}`, ...auditMeta(req),
      });
      return { id: asId(saved.id), secret: saved.secret };
    });
  },
  { permission: { module: 'settings', action: 'edit' } },
);
