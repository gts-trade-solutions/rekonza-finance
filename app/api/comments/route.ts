import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, body, query, asId, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';

// Comments on a record, and its history from the audit trail: what changed,
// by whom and why, beside the notes people left for each other. A comment is
// kept as written; there is no editing it afterwards.

const TARGETS = {
  invoice: 'sales', estimate: 'sales', sales_order: 'sales', credit_note: 'sales', contact: 'sales',
  bill: 'purchases', purchase_order: 'purchases', expense: 'purchases', vendor_credit: 'purchases',
  payment: 'sales', journal_entry: 'accountant', project: 'projects',
} as const;
type Target = keyof typeof TARGETS;
const TARGET = z.enum(Object.keys(TARGETS) as [Target, ...Target[]]);

/** A contact is both sides': either sales or purchasing may read and comment on it. */
const allowed = (role: Parameters<typeof hasPermission>[0], t: Target, action: 'view' | 'create') =>
  t === 'contact' ? hasPermission(role, 'sales', action) || hasPermission(role, 'purchases', action) : hasPermission(role, TARGETS[t], action);

export const GET = route(async ({ orgId, role, req }) => {
  const q = query(req, z.object({ targetType: TARGET, targetId: z.coerce.number().int().positive() }));
  if (!allowed(role, q.targetType, 'view')) throw forbidden('You cannot see that record.');
  const [comments, history] = await Promise.all([
    db.selectFrom('comments').selectAll().where('org_id', '=', orgId).where('target_type', '=', q.targetType).where('target_id', '=', q.targetId)
      .orderBy('created_at', 'desc').limit(200).execute(),
    db.selectFrom('audit_log').select(['id', 'action', 'actor_name', 'detail', 'reason', 'created_at'])
      .where('org_id', '=', orgId).where('target_type', '=', q.targetType).where('target_id', '=', String(q.targetId))
      .orderBy('id', 'desc').limit(200).execute(),
  ]);
  return {
    comments: comments.map((c) => ({ id: asId(c.id), author: c.author_name, body: c.body, at: new Date(c.created_at).toISOString() })),
    history: history.map((h) => ({ id: asId(h.id), action: h.action, actor: h.actor_name, detail: h.detail, reason: h.reason, at: new Date(h.created_at).toISOString() })),
  };
});

const PostInput = z.object({ targetType: TARGET, targetId: z.union([z.string(), z.number()]), body: z.string().trim().min(1, 'Write something first.').max(2000) });

export const POST = route(async ({ orgId, user, role, req }) => {
  const input = await body(req, PostInput);
  if (!allowed(role, input.targetType, 'view')) throw forbidden('You cannot see that record.');
  const r = await db.insertInto('comments').values({
    org_id: orgId, target_type: input.targetType, target_id: Number(input.targetId), user_id: user.userId, author_name: user.name, body: input.body,
  }).executeTakeFirstOrThrow();
  await logAudit({ orgId, actorUserId: user.userId, actorName: user.name, action: 'comment', targetType: input.targetType, targetId: Number(input.targetId), detail: input.body.slice(0, 200), ...auditMeta(req) });
  return { id: asId(Number(r.insertId)) };
});
