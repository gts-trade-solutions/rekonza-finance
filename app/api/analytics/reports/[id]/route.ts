import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, body, idParam } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deleteReport, getReport, updateReport } from '@/lib/server/analytics/reports';

export const GET = route(
  async ({ orgId, user, role, params }) => getReport(db, orgId, user.userId, role, idParam(params)),
  { permission: { module: 'analytics', action: 'view' } },
);

const Patch = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  description: z.string().trim().max(500).nullish(),
  visibility: z.enum(['private', 'org']).optional(),
  // Validated in full by the service against the chart-spec schema.
  layout: z.unknown().optional(),
  filters: z.unknown().optional(),
});

export const PATCH = route(
  async ({ orgId, user, role, req, params }) => {
    const id = idParam(params);
    const input = await body(req, Patch);
    await updateReport(db, orgId, user.userId, role, id, input);

    // Sharing is worth an audit line of its own: it changes who can see figures.
    if (input.visibility) {
      await logAudit({
        orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: 'analytics_report', targetId: id,
        detail: input.visibility === 'org' ? 'Shared the report with the organisation' : 'Made the report private',
        ...auditMeta(req),
      });
    }
    return getReport(db, orgId, user.userId, role, id);
  },
  { permission: { module: 'analytics', action: 'edit' } },
);

export const DELETE = route(
  async ({ orgId, user, role, req, params }) => {
    const id = idParam(params);
    const name = await deleteReport(db, orgId, user.userId, role, id);
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'void',
      targetType: 'analytics_report', targetId: id, targetLabel: name, detail: 'Deleted report',
      ...auditMeta(req),
    });
    return { ok: true };
  },
  { permission: { module: 'analytics', action: 'edit' } },
);
