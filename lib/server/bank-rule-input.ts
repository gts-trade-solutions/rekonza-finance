import { z } from 'zod';
import { asId } from './http';
import { categoryOf } from '../bank-categories';
import { ruleShapeOf } from '../bank-rules';
import type { RuleInput } from './services/bank-rules';

// Zoho's "New Rules" form as the rules routes take it, and a rule as they send
// it back (app/api/banking/rules and rules/[id]).

const Id = z.union([z.string(), z.number()]).transform(Number);

export const ZohoRuleInput = z.object({
  name: z.string().max(150),
  applyTo: z.enum(['deposits', 'withdrawals']),
  markAs: z.enum(['recognized', 'categorized']),
  matchMode: z.enum(['any', 'all']),
  criteria: z.array(z.object({
    field: z.enum(['narration', 'reference', 'amount']),
    op: z.enum(['equals', 'contains', 'starts_with', 'ends_with', 'not_contains', 'greater_than', 'less_than', 'gte', 'lte']),
    value: z.string().max(150),
  })).min(1, 'Add at least one criterion.').max(10),
  recordAs: z.string().max(40),
  accountId: Id.nullish(),
  otherBankAccountId: Id.nullish(),
  contactId: Id.nullish(),
  referenceMode: z.enum(['statement', 'none']).default('statement'),
  scope: z.enum(['all', 'banks', 'cards', 'custom']),
  scopeAccountIds: z.array(Id).max(100).nullish(),
});

export const toRuleInput = (i: z.infer<typeof ZohoRuleInput>): RuleInput => ({ ...i, scopeAccountIds: i.scopeAccountIds ?? null });

export interface RuleRow {
  id: number; name: string; priority: number; conditions: unknown; auto_confirm: number; is_active: number;
  apply_to: string | null; match_mode: string; record_as: string | null; reference_mode: string; account_scope: string;
  scope_account_ids: unknown; contact_id: number | null; action_account_id: number | null; account_code: string | null;
  account_name: string | null; bank_account_id: number | null; bank_name: string | null; other_bank_account_id: number | null; other_name: string | null;
}

export function ruleJson(r: RuleRow, timesApplied = 0) {
  const shape = ruleShapeOf(r);
  return {
    id: asId(r.id),
    name: r.name,
    priority: r.priority,
    applyTo: shape.applyTo,
    markAs: r.auto_confirm ? 'categorized' : 'recognized',
    matchMode: shape.matchMode,
    criteria: shape.criteria,
    /** Older callers read the criteria under this name. */
    conditions: shape.criteria,
    recordAs: r.record_as,
    recordAsLabel: r.record_as ? categoryOf(r.record_as as never)?.label ?? r.record_as : 'Categorize to account',
    accountId: r.action_account_id === null ? null : asId(r.action_account_id),
    accountCode: r.account_code,
    accountName: r.account_name,
    otherBankAccountId: r.other_bank_account_id === null ? null : asId(r.other_bank_account_id),
    otherBankName: r.other_name,
    contactId: r.contact_id === null ? null : asId(r.contact_id),
    referenceMode: r.reference_mode === 'none' ? 'none' : 'statement',
    scope: shape.scope,
    scopeAccountIds: (shape.scopeAccountIds ?? []).map(String),
    bankAccountId: r.bank_account_id === null ? null : asId(r.bank_account_id),
    bankName: r.bank_name,
    autoConfirm: !!r.auto_confirm,
    isActive: !!r.is_active,
    timesApplied,
  };
}
