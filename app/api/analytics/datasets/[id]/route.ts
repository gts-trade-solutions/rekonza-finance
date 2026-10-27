import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, body, idParam } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deleteDataset, getDataset, refreshDataset, updateDataset } from '@/lib/server/analytics/datasets';

// One dataset, with its rows. Fetched once per report and shared by every tile
// on it, so a six-chart dashboard costs one download, not six.

export const GET = route(
  async ({ orgId, params }) => getDataset(db, orgId, idParam(params)),
  { permission: { module: 'analytics', action: 'view' } },
);

const Patch = z.union([
  z.object({ action: z.literal('refresh') }),
  z.object({
    name: z.string().trim().min(1).max(150).optional(),
    description: z.string().trim().max(500).nullish(),
    columns: z
      .array(z.object({
        key: z.string().trim().min(1).max(20),
        label: z.string().trim().max(80).optional(),
        role: z.enum(['dimension', 'measure']).optional(),
      }))
      .max(60)
      .optional(),
  }),
]);

export const PATCH = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const input = await body(req, Patch);

    if ('action' in input) {
      await refreshDataset(db, orgId, id);
      await logAudit({
        orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: 'analytics_dataset', targetId: id, detail: 'Refreshed the snapshot from the books',
        ...auditMeta(req),
      });
    } else {
      await updateDataset(db, orgId, id, input);
    }
    // The caller already has the rows it needs; send back only what changed.
    const { columns, ...rest } = await getDataset(db, orgId, id);
    return { ...rest, rows: undefined, columns };
  },
  { permission: { module: 'analytics', action: 'edit' } },
);

export const DELETE = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    await deleteDataset(db, orgId, id);
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'void',
      targetType: 'analytics_dataset', targetId: id, detail: 'Deleted dataset', ...auditMeta(req),
    });
    return { ok: true };
  },
  { permission: { module: 'analytics', action: 'void' } },
);
