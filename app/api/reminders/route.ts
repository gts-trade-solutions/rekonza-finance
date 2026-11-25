import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deleteReminder, listReminders, markReminder, queueReminders, updateReminder } from '@/lib/server/services/reminders';
import { indiaToday } from '@/lib/server/services/held-journals';

// Payment reminders: the queue, sending them, and filling it now rather than waiting for the night's sweep.

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ status: z.enum(['queued', 'sent', 'skipped']).default('queued') }));
    return { reminders: await listReminders(db, orgId, q.status) };
  },
  { permission: { module: 'sales', action: 'view' } },
);

export const POST = route(
  async ({ orgId }) => ({ queued: await transaction((trx) => queueReminders(trx, orgId, indiaToday())) }),
  { permission: { module: 'sales', action: 'edit' } },
);

export const PATCH = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, z.object({ id: z.coerce.number().int().positive(), status: z.enum(['sent', 'skipped']) }));
    return transaction(async (trx) => {
      await markReminder(trx, orgId, user.userId, input.id, input.status);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: input.status === 'sent' ? 'send' : 'update',
        targetType: 'payment_reminder', targetId: input.id, detail: input.status === 'sent' ? 'Payment reminder sent' : 'Payment reminder skipped', ...auditMeta(req),
      });
      return { id: asId(input.id) };
    });
  },
  { permission: { module: 'sales', action: 'edit' } },
);

/** Edit a queued reminder: to, subject, message. */
export const PUT = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, z.object({
      id: z.coerce.number().int().positive(), to: z.string().max(190).nullish(), subject: z.string().max(200).nullish(), message: z.string().max(2000),
    }));
    return transaction(async (trx) => {
      await updateReminder(trx, orgId, input.id, input);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: 'payment_reminder', targetId: input.id, detail: `Payment reminder edited before sending${input.to ? `, to ${input.to}` : ''}`, ...auditMeta(req),
      });
      return { id: asId(input.id) };
    });
  },
  { permission: { module: 'sales', action: 'edit' } },
);

/** Delete a queued reminder (?id=): taken off the queue, kept as skipped so it is not queued again. */
export const DELETE = route(
  async ({ orgId, user, req }) => {
    const q = query(req, z.object({ id: z.coerce.number().int().positive(), reason: z.string().max(300).optional() }));
    return transaction(async (trx) => {
      await deleteReminder(trx, orgId, user.userId, q.id);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete',
        targetType: 'payment_reminder', targetId: q.id, detail: `Payment reminder deleted from the queue${q.reason ? ` — ${q.reason}` : ''}`, ...auditMeta(req),
      });
      return { deleted: true, id: asId(q.id) };
    });
  },
  { permission: { module: 'sales', action: 'edit' } },
);
