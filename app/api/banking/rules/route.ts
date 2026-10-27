import { z } from 'zod';
import { sql } from 'kysely';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, badRequest } from '@/lib/server/http';
import { applyRules } from '@/lib/server/services/banking';
import { logAudit, auditMeta } from '@/lib/server/audit';

// ─────────────────────────────────────────────────────────────────────────────
// Bank rules: teach the app to categorise repeating statement lines.
//
// Rules run in priority order and the first match wins, so a specific rule has
// to sit above a general one. Auto-confirm is off by default: a rule that
// silently miscategorises is worse than one that asks, because the wrong
// account only surfaces at year end when somebody queries the figure.
// ─────────────────────────────────────────────────────────────────────────────

interface Condition {
  field: string;
  op: string;
  value: string;
}

export const GET = route(
  async ({ orgId }) => {
    const rows = await db
      .selectFrom('bank_rules as r')
      .leftJoin('accounts as a', 'a.id', 'r.action_account_id')
      .leftJoin('bank_accounts as b', 'b.id', 'r.bank_account_id')
      .select([
        'r.id', 'r.name', 'r.priority', 'r.conditions', 'r.auto_confirm', 'r.is_active',
        'r.action_account_id', 'a.code as account_code', 'a.name as account_name',
        'r.bank_account_id', 'b.name as bank_name',
      ])
      .where('r.org_id', '=', orgId)
      .orderBy('r.priority')
      .execute();

    // How many lines each rule has actually caught, so a rule that never fires
    // is visible as such rather than quietly doing nothing.
    const { rows: hits } = await sql<{ id: number; n: string }>`
      SELECT applied_rule_id AS id, COUNT(*) AS n
        FROM bank_transactions
       WHERE org_id = ${orgId} AND applied_rule_id IS NOT NULL
       GROUP BY applied_rule_id
    `.execute(db);
    const hitBy = new Map(hits.map((h) => [h.id, Number(h.n)]));

    return {
      rules: rows.map((r) => ({
        id: asId(r.id),
        name: r.name,
        priority: r.priority,
        conditions: (typeof r.conditions === 'string'
          ? JSON.parse(r.conditions)
          : r.conditions) as Condition[],
        accountId: r.action_account_id === null ? null : asId(r.action_account_id),
        accountCode: r.account_code,
        accountName: r.account_name,
        bankAccountId: r.bank_account_id === null ? null : asId(r.bank_account_id),
        bankName: r.bank_name,
        autoConfirm: !!r.auto_confirm,
        isActive: !!r.is_active,
        timesApplied: hitBy.get(r.id) ?? 0,
      })),
    };
  },
  { permission: { module: 'banking', action: 'view' } },
);

const RuleInput = z.object({
  name: z.string().trim().min(1, 'Give the rule a name.').max(150),
  contains: z.string().trim().min(2, 'Match on at least two characters.').max(150),
  accountId: z.union([z.string(), z.number()]),
  bankAccountId: z.union([z.string(), z.number()]).nullish(),
  autoConfirm: z.boolean().optional(),
});

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, RuleInput);
    const accountId = Number(input.accountId);

    const account = await db
      .selectFrom('accounts').select(['id', 'code', 'name', 'type'])
      .where('id', '=', accountId).where('org_id', '=', orgId).executeTakeFirst();
    if (!account) throw badRequest('That account does not exist.');

    // Categorising a bank line means posting the other side of it. Pointing a
    // rule at a control account would let a statement line land in receivables
    // without any invoice behind it, and the ageing report would stop agreeing
    // with its own control account.
    if (account.code === '1100' || account.code === '2100') {
      throw badRequest(
        `${account.name} is a control account. Its balance comes from invoices and bills, so a bank line ` +
          'cannot be categorised straight into it — match the line to the document instead.',
      );
    }

    const last = await db
      .selectFrom('bank_rules').select(sql<number>`COALESCE(MAX(priority), 0)`.as('p'))
      .where('org_id', '=', orgId).executeTakeFirst();

    const inserted = await db
      .insertInto('bank_rules')
      .values({
        org_id: orgId,
        name: input.name,
        priority: Number(last?.p ?? 0) + 1,
        bank_account_id: input.bankAccountId ? Number(input.bankAccountId) : null,
        conditions: JSON.stringify([
          { field: 'narration', op: 'contains', value: input.contains },
        ]),
        action_account_id: accountId,
        auto_confirm: input.autoConfirm ? 1 : 0,
        is_active: 1,
      })
      .executeTakeFirstOrThrow();

    const id = Number(inserted.insertId);
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
      targetType: 'bank_rule', targetId: id, targetLabel: input.name,
      detail: `"${input.contains}" → ${account.code} ${account.name}`, ...auditMeta(req),
    });

    return { id: asId(id), name: input.name };
  },
  { permission: { module: 'banking', action: 'create' } },
);

const ActionInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('toggle'),
    id: z.union([z.string(), z.number()]),
    isActive: z.boolean(),
  }),
  z.object({
    action: z.literal('run'),
    bankAccountId: z.union([z.string(), z.number()]).nullish(),
  }),
]);

export const PATCH = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, ActionInput);

    if (input.action === 'toggle') {
      const id = Number(input.id);
      const rule = await db
        .selectFrom('bank_rules').select(['id', 'name'])
        .where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
      if (!rule) throw badRequest('That rule does not exist.');

      await db
        .updateTable('bank_rules').set({ is_active: input.isActive ? 1 : 0 })
        .where('id', '=', id).execute();
      return { id: asId(id), isActive: input.isActive };
    }

    const matched = await transaction((trx) =>
      applyRules(
        trx, orgId, user.userId,
        input.bankAccountId ? Number(input.bankAccountId) : undefined,
      ),
    );

    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'match',
      targetType: 'bank_rule', detail: `Ran all rules — ${matched} line(s) matched`, ...auditMeta(req),
    });

    return { matched };
  },
  { permission: { module: 'banking', action: 'edit' } },
);

export const DELETE = route(
  async ({ orgId, user, req }) => {
    const { id } = query(req, z.object({ id: z.string() }));
    const numeric = Number(id);

    const rule = await db
      .selectFrom('bank_rules').select(['id', 'name'])
      .where('id', '=', numeric).where('org_id', '=', orgId).executeTakeFirst();
    if (!rule) throw badRequest('That rule does not exist.');

    // Lines the rule already categorised keep their category. The rule is a
    // shortcut for making a decision, not the decision itself.
    await db.deleteFrom('bank_rules').where('id', '=', numeric).where('org_id', '=', orgId).execute();
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'void',
      targetType: 'bank_rule', targetId: numeric, targetLabel: rule.name,
      detail: 'Rule deleted. Lines it already categorised are unaffected.', ...auditMeta(req),
    });

    return { id: asId(numeric) };
  },
  { permission: { module: 'banking', action: 'edit' } },
);
