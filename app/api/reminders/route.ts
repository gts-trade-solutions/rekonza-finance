import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { listReminders, markReminder, queueReminders } from '@/lib/server/services/reminders';
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
