import { z } from 'zod';
import { sql } from 'kysely';
import { db } from '@/lib/server/db';
import { route, body, asId, badRequest } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';

// ─────────────────────────────────────────────────────────────────────────────
// Period locks, one per module.
//
// Locking is per module rather than one blunt period close because sales are
// usually finalised well before purchases are, and a single date forces you to
// wait for the slowest one.
//
// The lock is not advisory. The posting engine calls assertPeriodOpen before
// every entry it writes, so a locked module refuses backdated postings from
// every route at once — there is no screen that can slip past it.
// ─────────────────────────────────────────────────────────────────────────────

const MODULES = ['sales', 'purchases', 'banking', 'accountant'] as const;

export const GET = route(
  async ({ orgId }) => {
    const [locks, users] = await Promise.all([
      db
        .selectFrom('transaction_locks')
        .select(['id', 'module', 'locked_upto', 'reason', 'locked_by_user_id', 'updated_at'])
        .where('org_id', '=', orgId)
        .execute(),
      db.selectFrom('users').select(['id', 'name']).where('org_id', '=', orgId).execute(),
    ]);

    const nameById = new Map(users.map((u) => [u.id, u.name]));
    const byModule = new Map(locks.map((l) => [l.module, l]));

    // How many entries each lock protects, so the screen can say what it covers
    // rather than only when it starts.
    const { rows: counts } = await sql<{ module: string; n: string }>`
      SELECT tl.module, COUNT(je.id) AS n
        FROM transaction_locks tl
        LEFT JOIN journal_entries je
               ON je.org_id = tl.org_id
              AND tl.locked_upto IS NOT NULL
              AND je.entry_date <= tl.locked_upto
       WHERE tl.org_id = ${orgId}
       GROUP BY tl.module
    `.execute(db);
    const protectedBy = new Map(counts.map((c) => [c.module, Number(c.n)]));

    return {
      locks: MODULES.map((m) => {
        const l = byModule.get(m);
        return {
          module: m,
          id: l ? asId(l.id) : null,
          lockedUpto: l?.locked_upto ? String(l.locked_upto).slice(0, 10) : null,
          reason: l?.reason ?? null,
          lockedBy: l?.locked_by_user_id ? (nameById.get(l.locked_by_user_id) ?? null) : null,
          updatedAt: l?.updated_at
            ? (l.updated_at instanceof Date ? l.updated_at : new Date(String(l.updated_at))).toISOString()
            : null,
          protectedEntries: protectedBy.get(m) ?? 0,
        };
      }),
    };
  },
  { permission: { module: 'accountant', action: 'view' } },
);

const LockInput = z.object({
  module: z.enum(MODULES),
  /** null removes the lock. */
  lockedUpto: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  reason: z.string().trim().max(300).nullish(),
});

/**
 * Set or clear a module's lock.
 *
 * Unlocking is allowed — a genuine correction sometimes has to be made in a
 * closed period — but it is written to the audit trail with who did it and
 * when, which is the part that makes it a decision rather than a habit.
 */
export const PUT = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, LockInput);

    if (input.lockedUpto && !input.reason?.trim()) {
      throw badRequest('Give a reason — whoever hits this lock needs to know why it is there.');
    }

    const existing = await db
      .selectFrom('transaction_locks')
      .select(['id', 'locked_upto'])
      .where('org_id', '=', orgId)
      .where('module', '=', input.module)
      .executeTakeFirst();

    const values = {
      locked_upto: input.lockedUpto,
      reason: input.lockedUpto ? (input.reason?.trim() ?? 'Period finalised') : null,
      locked_by_user_id: user.userId,
    };

    if (existing) {
      await db.updateTable('transaction_locks').set(values).where('id', '=', existing.id).execute();
    } else {
      await db.insertInto('transaction_locks').values({ org_id: orgId, module: input.module, ...values }).execute();
    }

    await logAudit({
      orgId,
      actorUserId: user.userId,
      actorName: user.name,
      action: input.lockedUpto ? 'approve' : 'update',
      targetType: 'transaction_lock',
      targetId: input.module,
      targetLabel: input.module,
      detail: input.lockedUpto
        ? `Locked ${input.module} up to ${input.lockedUpto} — ${values.reason}`
        : `Removed the ${input.module} lock (was ${existing?.locked_upto ? String(existing.locked_upto).slice(0, 10) : 'unset'})`,
      ...auditMeta(req),
    });

    return { module: input.module, lockedUpto: input.lockedUpto };
  },
  { permission: { module: 'accountant', action: 'approve' } },
);
