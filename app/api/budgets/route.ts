import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, body, query, badRequest } from '@/lib/server/http';
import { toSqlFromPaise } from '@/lib/server/money-sql';
import { budgetVsActual } from '@/lib/server/reports/budgets';
import { logAudit, auditMeta } from '@/lib/server/audit';

// ─────────────────────────────────────────────────────────────────────────────
// Budget vs actual: the figures are worked out in lib/server/reports/budgets.ts,
// which the assistant reads too.
// ─────────────────────────────────────────────────────────────────────────────

const ListQuery = z.object({
  fy: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  /** Compare actuals up to this date rather than the whole year. */
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, ListQuery);
    return budgetVsActual(db, orgId, { fy: q.fy, asOf: q.asOf, today: new Date().toISOString().slice(0, 10) });
  },
  { permission: { module: 'accountant', action: 'view' } },
);

const SetInput = z.object({
  fy: z.string().regex(/^\d{4}-\d{2}$/),
  entries: z
    .array(
      z.object({
        accountId: z.union([z.string(), z.number()]),
        amountPaise: z.number().int().min(0),
        notes: z.string().trim().max(500).nullish(),
      }),
    )
    .min(1),
});

/**
 * Set budgets for a year.
 *
 * Upserts, because setting a budget is something people do repeatedly as the
 * plan firms up, and a zero deletes the row rather than storing a meaningless
 * target of nothing.
 */
export const PUT = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, SetInput);

    const ids = input.entries.map((e) => Number(e.accountId));
    const valid = await db
      .selectFrom('accounts').select(['id'])
      .where('org_id', '=', orgId).where('id', 'in', ids).execute();
    const validIds = new Set(valid.map((v) => v.id));
    const unknown = ids.filter((i) => !validIds.has(i));
    if (unknown.length) throw badRequest('One of those accounts does not exist.');

    for (const e of input.entries) {
      const accountId = Number(e.accountId);
      if (e.amountPaise === 0) {
        await db
          .deleteFrom('budgets')
          .where('org_id', '=', orgId)
          .where('fy_label', '=', input.fy)
          .where('account_id', '=', accountId)
          .execute();
        continue;
      }
      await db
        .insertInto('budgets')
        .values({
          org_id: orgId,
          // 0 means "all branches". Not NULL: MySQL's unique index treats NULLs
          // as distinct, so a nullable column here would let duplicates through.
          branch_id: 0,
          account_id: accountId,
          fy_label: input.fy,
          amount: toSqlFromPaise(e.amountPaise),
          notes: e.notes ?? null,
          created_by_user_id: user.userId,
        })
        .onDuplicateKeyUpdate({
          amount: toSqlFromPaise(e.amountPaise),
          notes: e.notes ?? null,
        })
        .execute();
    }

    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
      targetType: 'budget', targetId: input.fy, targetLabel: `FY ${input.fy}`,
      detail: `Set ${input.entries.length} budget figure(s) for ${input.fy}`, ...auditMeta(req),
    });

    return { fy: input.fy, updated: input.entries.length };
  },
  { permission: { module: 'accountant', action: 'edit' } },
);
