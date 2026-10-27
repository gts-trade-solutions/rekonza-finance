import { z } from 'zod';
import { route, body } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';

// A copy taken: a page printed or a file downloaded. The audit trail shows who
// took what, which the DPDP Act expects of anyone holding personal data.

export const POST = route(async ({ orgId, user, req }) => {
  const input = await body(req, z.object({ action: z.enum(['print', 'export']), what: z.string().max(200), path: z.string().max(300) }));
  await logAudit({
    orgId, actorUserId: user.userId, actorName: user.name, action: 'export', targetType: 'output', targetId: input.path,
    targetLabel: input.what, detail: `${input.action === 'print' ? 'Printed' : 'Exported'} ${input.what} (${input.path})`, ...auditMeta(req),
  });
  return { ok: true };
});
