import { z } from 'zod';
import { sql } from 'kysely';
import { db } from '@/lib/server/db';
import { route, body, query, asId, badRequest } from '@/lib/server/http';
import { toPaiseFromSql, toSqlFromPaise } from '@/lib/server/money-sql';
import { logAudit, auditMeta } from '@/lib/server/audit';

// ─────────────────────────────────────────────────────────────────────────────
// Budget vs actual.
//
// The actuals come from the journal, not from a second store of numbers, and
// they are matched to the budget by account id. That is the whole reason
// budgets are held per account: there is no category mapping in the middle for
// the two sides to disagree about.
// ─────────────────────────────────────────────────────────────────────────────

/** '2026-27' for any date in the 2026-27 financial year. India runs Apr–Mar. */
function fyLabelFor(date: string): string {
  const [y, m] = date.split('-').map(Number);
  const start = m < 4 ? y - 1 : y;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

function fyRange(label: string): { from: string; to: string } {
  const start = Number(label.slice(0, 4));
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` };
}

const ListQuery = z.object({
  fy: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  /** Compare actuals up to this date rather than the whole year. */
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, ListQuery);
    const today = new Date().toISOString().slice(0, 10);
    const fy = q.fy ?? fyLabelFor(today);
    const range = fyRange(fy);
    // Year-to-date by default: comparing a full-year budget against a full year
    // of actuals that has not happened yet makes everything look under budget.
    const asOf = q.asOf ?? (today < range.to ? today : range.to);

    const budgets = await db
      .selectFrom('budgets')
      .innerJoin('accounts', 'accounts.id', 'budgets.account_id')
      .select([
        'budgets.id', 'budgets.account_id', 'budgets.amount', 'budgets.notes',
        'accounts.code', 'accounts.name', 'accounts.type',
      ])
      .where('budgets.org_id', '=', orgId)
      .where('budgets.fy_label', '=', fy)
      .orderBy('accounts.code')
      .execute();

    const { rows: actuals } = await sql<{ id: number; v: string }>`
      SELECT jl.account_id AS id, COALESCE(SUM(jl.debit - jl.credit), 0) AS v
        FROM journal_lines jl
       WHERE jl.org_id = ${orgId}
         AND jl.entry_date BETWEEN ${range.from} AND ${asOf}
       GROUP BY jl.account_id
    `.execute(db);
    const actualBy = new Map(actuals.map((a) => [a.id, toPaiseFromSql(a.v)]));

    // How far through the year we are, so an account can be flagged as ahead of
    // pace rather than merely under its annual total.
    const elapsed = Math.max(
      0,
      Math.min(1, (new Date(asOf).getTime() - new Date(range.from).getTime())
        / (new Date(range.to).getTime() - new Date(range.from).getTime())),
    );

    const rows = budgets.map((b) => {
      const raw = actualBy.get(b.account_id) ?? 0;
      // Income is credit-normal, so its actual arrives negative from a
      // debit-minus-credit sum. Both sides are shown as positive spend/earn.
      const actual = b.type === 'income' ? -raw : raw;
      const budget = toPaiseFromSql(b.amount);
      return {
        id: asId(b.id),
        accountId: asId(b.account_id),
        code: b.code,
        name: b.name,
        type: b.type,
        budgetPaise: budget,
        actualPaise: actual,
        variancePaise: budget - actual,
        pct: budget > 0 ? (actual / budget) * 100 : 0,
        notes: b.notes,
      };
    });

    return {
      fy,
      from: range.from,
      to: range.to,
      asOf,
      elapsedPct: elapsed * 100,
      rows,
      totals: {
        budgetPaise: rows.reduce((t, r) => t + r.budgetPaise, 0),
        actualPaise: rows.reduce((t, r) => t + r.actualPaise, 0),
      },
    };
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
