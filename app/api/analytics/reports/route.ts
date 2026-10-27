import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, body, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { copyReport, createReport, listReports } from '@/lib/server/analytics/reports';

export const GET = route(
  async ({ orgId, user }) => ({ reports: await listReports(db, orgId, user.userId) }),
  { permission: { module: 'analytics', action: 'view' } },
);

const Input = z.union([
  z.object({
    datasetId: z.union([z.string(), z.number()]),
    name: z.string().trim().min(1, 'Give the report a name.').max(150),
    description: z.string().trim().max(500).nullish(),
    /** Start from the automatic layout, or from a blank canvas. */
    starter: z.boolean().optional(),
    visibility: z.enum(['private', 'org']).optional(),
  }),
  z.object({ copyOf: z.union([z.string(), z.number()]) }),
]);

export const POST = route(
  async ({ orgId, user, role, req }) => {
    const input = await body(req, Input);
    const id =
      'copyOf' in input
        ? await copyReport(db, orgId, user.userId, role, Number(input.copyOf))
        : await createReport(db, orgId, user.userId, {
            datasetId: Number(input.datasetId),
            name: input.name,
            description: input.description,
            starter: input.starter,
            visibility: input.visibility,
          });

    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
      targetType: 'analytics_report', targetId: id,
      detail: 'copyOf' in input ? `Copied report ${input.copyOf}` : `Created report "${input.name}"`,
      ...auditMeta(req),
    });
    return { id: asId(id) };
  },
  { permission: { module: 'analytics', action: 'create' } },
);
