import { z } from 'zod';
import { sql } from 'kysely';
import { db } from '@/lib/server/db';
import { route, query, asId } from '@/lib/server/http';

// ─────────────────────────────────────────────────────────────────────────────
// The audit trail, read-only.
//
// There is no POST here and no DELETE, deliberately. MCA Rule 11(g) requires
// Indian companies keeping books electronically to maintain an edit log of
// every change, retain it for eight financial years, and to have no facility
// for disabling it. Rows are written by lib/server/audit.ts as a side effect of
// the actions they describe; nothing can write one directly, and nothing at all
// can remove one.
// ─────────────────────────────────────────────────────────────────────────────

const ListQuery = z.object({
  targetType: z.string().optional(),
  action: z.string().optional(),
  actorUserId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(300),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, ListQuery);

    let base = db.selectFrom('audit_log').where('org_id', '=', orgId);
    if (q.targetType && q.targetType !== 'all') base = base.where('target_type', '=', q.targetType);
    if (q.action && q.action !== 'all') base = base.where('action', '=', q.action);
    if (q.actorUserId) base = base.where('actor_user_id', '=', Number(q.actorUserId));
    if (q.from) base = base.where('created_at', '>=', new Date(`${q.from}T00:00:00`));
    // Inclusive of the end date, so a single-day filter shows that whole day.
    if (q.to) base = base.where('created_at', '<=', new Date(`${q.to}T23:59:59.999`));
    if (q.search) {
      const term = `%${q.search}%`;
      base = base.where((eb) =>
        eb.or([
          eb('actor_name', 'like', term),
          eb('target_label', 'like', term),
          eb('detail', 'like', term),
        ]),
      );
    }

    const [rows, total, kinds, guards] = await Promise.all([
      base
        .select([
          'id', 'actor_user_id', 'actor_name', 'action', 'target_type', 'target_id',
          'target_label', 'detail', 'ip', 'created_at', 'payload',
        ])
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(q.limit)
        .offset(q.offset)
        .execute(),
      base.select(sql<string>`COUNT(*)`.as('n')).executeTakeFirst(),
      // The distinct record types present, so the filter offers only what exists.
      db
        .selectFrom('audit_log')
        .select(['target_type', sql<string>`COUNT(*)`.as('n')])
        .where('org_id', '=', orgId)
        .groupBy('target_type')
        .orderBy('target_type')
        .execute(),
      // Whether the database itself refuses edits and deletes (npm run
      // db:protect). Six triggers: no update and no delete on each table.
      sql<{ n: string }>`
        SELECT COUNT(*) AS n FROM information_schema.TRIGGERS
         WHERE TRIGGER_SCHEMA = DATABASE()
           AND TRIGGER_NAME IN ('trg_audit_log_no_update', 'trg_audit_log_no_delete',
                                'trg_journal_entries_no_update', 'trg_journal_entries_no_delete',
                                'trg_journal_lines_no_update', 'trg_journal_lines_no_delete')
      `.execute(db),
    ]);

    return {
      events: rows.map((r) => ({
        id: asId(r.id),
        at: (r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at))).toISOString(),
        actorUserId: r.actor_user_id === null ? null : asId(r.actor_user_id),
        actorName: r.actor_name ?? 'System',
        action: r.action,
        targetType: r.target_type ?? 'other',
        targetId: r.target_id,
        targetLabel: r.target_label ?? '—',
        detail: r.detail ?? '',
        ip: r.ip,
        changes: changesIn(r.payload),
      })),
      targetTypes: kinds
        .filter((k) => k.target_type)
        .map((k) => ({ value: k.target_type as string, count: Number(k.n) })),
      total: Number(total?.n ?? 0),
      databaseProtected: Number(guards.rows[0]?.n ?? 0) === 6,
    };
  },
  { permission: { module: 'accountant', action: 'view' } },
);

/** The edit log an update carries, if it carries one. */
function changesIn(payload: unknown): Record<string, { from: unknown; to: unknown }> | null {
  const p = typeof payload === 'string' ? safeParse(payload) : payload;
  const c = p && typeof p === 'object' ? (p as { changes?: unknown }).changes : null;
  return c && typeof c === 'object' && Object.keys(c).length ? (c as Record<string, { from: unknown; to: unknown }>) : null;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
