import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, notFound, forbidden, badRequest } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';

// ─────────────────────────────────────────────────────────────────────────────
// Reports → Custom Reports: the reports saved from Customize Report, with
// their period and filters, under a name — private to the person who saved
// them, or shared with the company. They live in saved_views under the list
// "report-<name>" (the saved-views store the lists use too), so the report
// pages' own Views menu sees them as well. Edit renames, shares or unshares
// one, or replaces its settings; Delete removes it. Only the person who saved
// one may change it.
// ─────────────────────────────────────────────────────────────────────────────

const REPORTS = ['profit-and-loss', 'balance-sheet', 'trial-balance', 'general-ledger', 'account-transactions', 'cash-flow'] as const;
const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown>;

export const GET = route(async ({ orgId, user, req }) => {
  const q = query(req, z.object({ id: z.coerce.number().int().positive().optional() }));
  let qb = db.selectFrom('saved_views as v').leftJoin('users as u', 'u.id', 'v.user_id')
    .select(['v.id', 'v.list', 'v.name', 'v.filters', 'v.is_shared', 'v.user_id', 'v.created_at', 'u.name as owner'])
    .where('v.org_id', '=', orgId).where('v.list', 'in', REPORTS.map((r) => `report-${r}`))
    .where((eb) => eb.or([eb('v.user_id', '=', user.userId), eb('v.is_shared', '=', 1)]));
  if (q.id) qb = qb.where('v.id', '=', q.id);
  const rows = await qb.orderBy('v.name').execute();
  if (q.id && !rows.length) throw notFound('That custom report does not exist, or is not shared with you.');
  return {
    reports: rows.map((r) => ({
      id: asId(r.id), report: r.list.replace(/^report-/, ''), name: r.name, shared: !!r.is_shared, mine: r.user_id === user.userId,
      owner: r.owner, createdAt: new Date(r.created_at).toISOString(), spec: parse(r.filters),
    })),
  };
}, { permission: { module: 'reports', action: 'view' } });

const Save = z.object({
  report: z.enum(REPORTS),
  name: z.string().trim().min(1, 'Name the report.').max(80),
  shared: z.boolean().optional(),
  spec: z.record(z.string(), z.unknown()),
});

/** Save as custom report. */
export const POST = route(async ({ orgId, user, req }) => {
  const input = await body(req, Save);
  const json = JSON.stringify(input.spec);
  if (json.length > 8000) throw badRequest('That report holds too many filters to save.');
  return transaction(async (trx) => {
    const r = await trx.insertInto('saved_views').values({
      org_id: orgId, user_id: user.userId, list: `report-${input.report}`, name: input.name, filters: json, is_shared: input.shared ? 1 : 0,
    }).executeTakeFirstOrThrow();
    const id = Number(r.insertId);
    await logAudit({
      trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'custom_report', targetId: id, targetLabel: input.name,
      detail: `Saved a custom ${input.report.replace(/-/g, ' ')} report "${input.name}"${input.shared ? ', shared with the company' : ', private'}`, ...auditMeta(req),
    });
    return { id: asId(id) };
  });
}, { permission: { module: 'reports', action: 'view' } });

const Edit = z.object({
  id: z.union([z.string(), z.number()]).transform(Number),
  name: z.string().trim().min(1).max(80).optional(),
  shared: z.boolean().optional(),
  spec: z.record(z.string(), z.unknown()).optional(),
});

async function mine(orgId: number, userId: number, id: number) {
  const v = await db.selectFrom('saved_views').select(['user_id', 'name', 'list']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!v || !v.list.startsWith('report-')) throw notFound('That custom report does not exist.');
  if (v.user_id !== userId) throw forbidden('Only the person who saved a custom report can change or delete it.');
  return v;
}

export const PATCH = route(async ({ orgId, user, req }) => {
  const input = await body(req, Edit);
  const v = await mine(orgId, user.userId, input.id);
  return transaction(async (trx) => {
    await trx.updateTable('saved_views').set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.shared !== undefined ? { is_shared: input.shared ? 1 : 0 } : {}),
      ...(input.spec !== undefined ? { filters: JSON.stringify(input.spec) } : {}),
    }).where('id', '=', input.id).execute();
    await logAudit({
      trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'custom_report', targetId: input.id, targetLabel: input.name ?? v.name,
      detail: `Changed the custom report "${v.name}"${input.name && input.name !== v.name ? `: renamed "${input.name}"` : ''}${input.shared !== undefined ? `: ${input.shared ? 'shared with the company' : 'made private'}` : ''}${input.spec ? ': settings replaced' : ''}`,
      payload: input.name && input.name !== v.name ? { changes: { name: { from: v.name, to: input.name } } } : undefined,
      ...auditMeta(req),
    });
    return { id: asId(input.id) };
  });
}, { permission: { module: 'reports', action: 'view' } });

export const DELETE = route(async ({ orgId, user, req }) => {
  const q = query(req, z.object({ id: z.coerce.number().int().positive(), reason: z.string().max(300).optional() }));
  const v = await mine(orgId, user.userId, q.id);
  return transaction(async (trx) => {
    await trx.deleteFrom('saved_views').where('id', '=', q.id).execute();
    await logAudit({
      trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete', targetType: 'custom_report', targetId: q.id, targetLabel: v.name,
      detail: `Deleted the custom report "${v.name}"`, reason: q.reason ?? null, ...auditMeta(req),
    });
    return { deleted: true };
  });
}, { permission: { module: 'reports', action: 'view' } });
