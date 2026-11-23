import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Zoho Books' transaction rules: saving one from its "New Rules" form.
//
// The form's choices are checked against what the server can actually do with
// them (lib/bank-rules.ts): a rule records a line as one of the categories that
// need only an account — an expense, a deposit, a transfer … — never a
// customer's or vendor's payment, whose invoices or bills a rule cannot know.
// Pointing a rule at receivables or payables is refused for the same reason:
// those balances come from documents.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Trx } from '../db';
import { badRequest, notFound } from '../http';
import { CODE } from '../ledger/chart-of-accounts';
import { categoryOf } from '../../bank-categories';
import {
  RULE_RECORD_AS, opsFor, type RuleApplyTo, type RuleCriterion, type RuleMatchMode, type RuleScope,
} from '../../bank-rules';

export interface RuleInput {
  name: string;
  applyTo: RuleApplyTo;
  markAs: 'recognized' | 'categorized';
  matchMode: RuleMatchMode;
  criteria: RuleCriterion[];
  recordAs: string;
  accountId?: number | null;
  otherBankAccountId?: number | null;
  contactId?: number | null;
  referenceMode: 'statement' | 'none';
  scope: RuleScope;
  scopeAccountIds?: number[] | null;
}

async function checked(trx: Trx, orgId: number, input: RuleInput) {
  const name = input.name.trim();
  if (!name) throw badRequest('Enter a rule name.');
  const criteria = input.criteria.map((c) => ({ field: c.field, op: c.op, value: String(c.value ?? '').trim() }));
  if (!criteria.length) throw badRequest('Add at least one criterion.');
  for (const [i, c] of criteria.entries()) {
    if (!opsFor(c.field).some((o) => o.value === c.op)) throw badRequest(`Criterion ${i + 1}: choose a comparison.`);
    if (!c.value) throw badRequest(`Criterion ${i + 1}: enter what to compare with.`);
    if (c.field === 'amount' && !Number.isFinite(Number(c.value.replace(/,/g, '')))) throw badRequest(`Criterion ${i + 1}: the amount is a number.`);
  }
  if (!(RULE_RECORD_AS[input.applyTo] as string[]).includes(input.recordAs)) throw badRequest('Choose how to record the transactions.');
  const cat = categoryOf(input.recordAs as never)!;
  let accountId: number | null = null;
  let otherBankAccountId: number | null = null;
  if (cat.engine === 'transfer') {
    if (!input.otherBankAccountId) throw badRequest('Choose the account.');
    const other = await trx.selectFrom('bank_accounts').select(['id', 'kind']).where('id', '=', input.otherBankAccountId).where('org_id', '=', orgId).executeTakeFirst();
    if (!other) throw notFound('That account does not exist.');
    if (cat.otherAccount === 'card' && other.kind !== 'card') throw badRequest('A card payment goes to a credit card account.');
    otherBankAccountId = other.id;
  } else {
    if (!input.accountId) throw badRequest('Choose the account.');
    const acct = await trx.selectFrom('accounts').select(['id', 'code', 'name', 'type']).where('id', '=', input.accountId).where('org_id', '=', orgId).executeTakeFirst();
    if (!acct) throw notFound('That account does not exist.');
    if (acct.code === CODE.AR || acct.code === CODE.AP) {
      throw badRequest(`${acct.name} is a control account. Its balance comes from invoices and bills, so a rule cannot record lines into it.`);
    }
    if (cat.accountTypes && !cat.accountTypes.includes(acct.type as never)) throw badRequest(`${acct.name} is not an account ${cat.label} can go to.`);
    accountId = acct.id;
  }
  const scopeIds = input.scope === 'custom' ? [...new Set((input.scopeAccountIds ?? []).map(Number))] : null;
  if (input.scope === 'custom' && !scopeIds?.length) throw badRequest('Choose the accounts the rule is for.');
  if (scopeIds?.length) {
    const found = await trx.selectFrom('bank_accounts').select('id').where('org_id', '=', orgId).where('id', 'in', scopeIds).execute();
    if (found.length !== scopeIds.length) throw badRequest('One of the chosen accounts does not exist.');
  }
  return {
    name, apply_to: input.applyTo, match_mode: input.matchMode, conditions: JSON.stringify(criteria), record_as: input.recordAs,
    reference_mode: input.referenceMode, account_scope: input.scope, scope_account_ids: scopeIds ? JSON.stringify(scopeIds) : null,
    // The one account column older rules used: kept in step for a rule on a single account.
    bank_account_id: scopeIds?.length === 1 ? scopeIds[0] : null,
    action_account_id: accountId, other_bank_account_id: otherBankAccountId, contact_id: input.contactId ?? null,
    auto_confirm: input.markAs === 'categorized' ? 1 : 0,
  };
}

export async function createRule(trx: Trx, orgId: number, input: RuleInput): Promise<number> {
  const values = await checked(trx, orgId, input);
  const { rows } = await sql<{ p: number }>`SELECT COALESCE(MAX(priority), 0) AS p FROM bank_rules WHERE org_id = ${orgId}`.execute(trx);
  const r = await trx.insertInto('bank_rules').values({ org_id: orgId, priority: Number(rows[0]?.p ?? 0) + 1, is_active: 1, ...values }).executeTakeFirstOrThrow();
  return Number(r.insertId);
}

export async function updateRule(trx: Trx, orgId: number, id: number, input: RuleInput): Promise<void> {
  const rule = await trx.selectFrom('bank_rules').select('id').where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!rule) throw notFound('That rule does not exist.');
  const values = await checked(trx, orgId, input);
  await trx.updateTable('bank_rules').set(values).where('id', '=', id).execute();
  // What the rule recognised before may no longer be what it recognises now: applyRules notes it afresh.
  await trx.updateTable('bank_transactions').set({ applied_rule_id: null })
    .where('org_id', '=', orgId).where('applied_rule_id', '=', id).where('status', '=', 'unmatched').execute();
}
