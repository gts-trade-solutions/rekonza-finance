import { z } from 'zod';
import { transaction } from '@/lib/server/db';
import { route, body } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { decideTime } from '@/lib/server/services/projects';
import { notify } from '@/lib/server/services/notifications';

// Approving logged time, or turning it back with a reason (services/projects.ts).

const ID = z.union([z.string(), z.number()]).transform(Number);
const Input = z.object({ ids: z.array(ID).min(1).max(500), decision: z.enum(['approved', 'rejected']), note: z.string().trim().max(300).nullish() });

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    return transaction(async (trx) => {
      const r = await decideTime(trx, orgId, user.userId, input.ids, input.decision, input.note ?? null);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'approve', targetType: 'time_entry', targetId: input.ids[0],
        detail: `${r.count} time entr${r.count === 1 ? 'y' : 'ies'} ${input.decision === 'approved' ? 'approved' : `turned back: ${input.note}`}`, ...auditMeta(req),
      });
      if (input.decision === 'rejected') {
        await notify(trx, orgId, r.people, { kind: 'timesheet', title: `${user.name} turned back ${r.count} of your time entr${r.count === 1 ? 'y' : 'ies'}`, body: input.note ?? undefined, href: '/projects/timesheet' });
      }
      return { count: r.count };
    });
  },
  { permission: { module: 'projects', action: 'approve' } },
);
