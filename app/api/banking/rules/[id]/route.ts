import { db, transaction } from '@/lib/server/db';
import { route, body, idParam, notFound, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { updateRule } from '@/lib/server/services/bank-rules';
import { ZohoRuleInput, ruleJson, toRuleInput } from '@/lib/server/bank-rule-input';

// One transaction rule: as saved, for Zoho's Edit Rule form, and saved back.

export const GET = route(
  async ({ orgId, params }) => {
    const id = idParam(params);
    const r = await db.selectFrom('bank_rules as r')
      .leftJoin('accounts as a', 'a.id', 'r.action_account_id')
      .leftJoin('bank_accounts as b', 'b.id', 'r.bank_account_id')
      .leftJoin('bank_accounts as o', 'o.id', 'r.other_bank_account_id')
      .select([
        'r.id', 'r.name', 'r.priority', 'r.conditions', 'r.auto_confirm', 'r.is_active', 'r.apply_to', 'r.match_mode',
        'r.record_as', 'r.reference_mode', 'r.account_scope', 'r.scope_account_ids', 'r.contact_id',
        'r.action_account_id', 'a.code as account_code', 'a.name as account_name',
        'r.bank_account_id', 'b.name as bank_name', 'r.other_bank_account_id', 'o.name as other_name',
      ])
      .where('r.id', '=', id).where('r.org_id', '=', orgId).executeTakeFirst();
    if (!r) throw notFound('That rule does not exist.');
    return { rule: ruleJson(r) };
  },
  { permission: { module: 'banking', action: 'view' } },
);

export const PUT = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const input = await body(req, ZohoRuleInput);
    await transaction((trx) => updateRule(trx, orgId, id, toRuleInput(input)));
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'bank_rule', targetId: id,
      targetLabel: input.name.trim(), detail: `${input.applyTo}, ${input.markAs}, ${input.criteria.length} criteria → ${input.recordAs}`, ...auditMeta(req),
    });
    return { id: asId(id) };
  },
  { permission: { module: 'banking', action: 'edit' } },
);
