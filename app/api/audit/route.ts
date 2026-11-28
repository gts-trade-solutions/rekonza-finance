import { z } from 'zod';
import { sql } from 'kysely';
import { db } from '@/lib/server/db';
import { route, query, asId } from '@/lib/server/http';
import { AuditFilter, auditRows, changesIn } from '@/lib/server/audit-query';
import { chainHead, sealAuditChain } from '@/lib/server/audit-chain';

// ─────────────────────────────────────────────────────────────────────────────
// The audit trail, read-only.
//
// There is no POST here and no DELETE, deliberately. MCA Rule 11(g) requires
// Indian companies keeping books electronically to maintain an edit log of
// every change, retain it for eight financial years, and to have no facility
// for disabling it. Rows are written by lib/server/audit.ts as a side effect of
// the actions they describe, and by POST /api/audit/output when a person prints
// or downloads something (their own act, recorded under their own name);
// nothing can write any other row directly, and nothing at all can remove one.
// GET /api/audit/export takes every row these filters find, as a file.
// POST /api/audit/verify walks the hash chain (lib/server/audit-chain.ts).
// ─────────────────────────────────────────────────────────────────────────────

const ListQuery = AuditFilter.extend({
  limit: z.coerce.number().int().min(1).max(1000).default(300),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, ListQuery);
    // New rows into the hash chain as the trail is opened (a busy book's backlog a piece at a time).
    await sealAuditChain(orgId, { max: 20_000 }).catch((err) => console.error('[audit-chain] seal on open failed', err));
    const base = auditRows(orgId, q);

    const [rows, total, kinds, guards, actors, chain] = await Promise.all([
      base
        .select([
          'id', 'actor_user_id', 'actor_name', 'action', 'target_type', 'target_id',
          'target_label', 'detail', 'reason', 'ip', 'created_at', 'payload',
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
      // Everyone who appears in the trail, for the User filter: a person who has left still shows.
      db.selectFrom('audit_log')
        .select(['actor_user_id', sql<string>`MAX(actor_name)`.as('name'), sql<string>`COUNT(*)`.as('n')])
        .where('org_id', '=', orgId).where('actor_user_id', 'is not', null)
        .groupBy('actor_user_id').execute(),
      chainHead(db, orgId),
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
        reason: r.reason,
        ip: r.ip,
        changes: changesIn(r.payload),
      })),
      targetTypes: kinds
        .filter((k) => k.target_type)
        .map((k) => ({ value: k.target_type as string, count: Number(k.n) })),
      total: Number(total?.n ?? 0),
      databaseProtected: Number(guards.rows[0]?.n ?? 0) === 6,
      actors: actors.map((a) => ({ id: asId(a.actor_user_id as number), name: a.name ?? 'Unknown', count: Number(a.n) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      chain,
    };
  },
  { permission: { module: 'accountant', action: 'view' } },
);
