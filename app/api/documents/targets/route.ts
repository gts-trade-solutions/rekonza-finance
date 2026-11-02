import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { attachmentPermission } from '@/lib/server/files/attachments';
import { ATTACH_TARGETS, findTargets } from '@/lib/server/files/library';

// The records a file in Documents can be attached to, found by number or
// name — and only kinds the user may attach files to.

const Q = z.object({
  type: z.enum(ATTACH_TARGETS.map((t) => t.type) as [string, ...string[]]).optional(),
  q: z.string().max(100).default(''),
});

export const GET = route(async ({ orgId, role, req }) => {
  const q = query(req, Q);
  const allowed = ATTACH_TARGETS.filter((t) => {
    const { module, action } = attachmentPermission(t.type, 'write');
    return hasPermission(role, module, action);
  });
  if (!q.type) return { types: allowed };
  const t = allowed.find((x) => x.type === q.type);
  if (!t) throw forbidden('Your role cannot attach files to that.');
  return { types: allowed, results: await findTargets(db, orgId, t.type, q.q) };
});
