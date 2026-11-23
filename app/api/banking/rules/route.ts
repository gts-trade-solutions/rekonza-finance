import { z } from 'zod';
import { sql } from 'kysely';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, badRequest } from '@/lib/server/http';
import { applyRules } from '@/lib/server/services/banking';
import { createRule } from '@/lib/server/services/bank-rules';
import { ZohoRuleInput, ruleJson, toRuleInput } from '@/lib/server/bank-rule-input';
import { logAudit, auditMeta } from '@/lib/server/audit';

// ─────────────────────────────────────────────────────────────────────────────
// Bank rules: teach the app to categorise repeating statement lines.
//
// Rules run in priority order and the first match wins, so a specific rule has
// to sit above a general one. A rule only Recognizes lines unless it is set to
// Categorize them: a rule that silently miscategorises is worse than one that
// asks, because the wrong account only surfaces at year end when somebody
// queries the figure. Zoho's "New Rules" form: services/bank-rules.ts.
// ─────────────────────────────────────────────────────────────────────────────


export const GET = route(
  async ({ orgId }) => {
    const rows = await db
      .selectFrom('bank_rules as r')
      .leftJoin('accounts as a', 'a.id', 'r.action_account_id')
      .leftJoin('bank_accounts as b', 'b.id', 'r.bank_account_id')
      .leftJoin('bank_accounts as o', 'o.id', 'r.other_bank_account_id')
      .select([
        'r.id', 'r.name', 'r.priority', 'r.conditions', 'r.auto_confirm', 'r.is_active', 'r.apply_to', 'r.match_mode',
        'r.record_as', 'r.reference_mode', 'r.account_scope', 'r.scope_account_ids', 'r.contact_id',
        'r.action_account_id', 'a.code as account_code', 'a.name as account_name',
        'r.bank_account_id', 'b.name as bank_name', 'r.other_bank_account_id', 'o.name as other_name',
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

    return { rules: rows.map((r) => ruleJson(r, hitBy.get(r.id) ?? 0)) };
  },
  { permission: { module: 'banking', action: 'view' } },
);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, ZohoRuleInput);
    const id = await transaction((trx) => createRule(trx, orgId, toRuleInput(input)));
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
      targetType: 'bank_rule', targetId: id, targetLabel: input.name.trim(),
      detail: `${input.applyTo}, ${input.markAs}, ${input.criteria.length} criteria → ${input.recordAs}`, ...auditMeta(req),
    });
    return { id: asId(id), name: input.name.trim() };
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
