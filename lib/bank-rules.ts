// Zoho Books' transaction rules: which statement lines a rule catches, and the
// choices its "New Rules" form offers. Shared by the form and the server
// (lib/server/services/banking.ts applyRules), so what the form lets a person
// write is exactly what the server runs.
//
// A rule applies to deposits or to withdrawals, on all accounts, all banks,
// all cards or a chosen few; its criteria all have to match, or any one may.
// A text criterion is compared without case; an amount is typed in rupees.

import { BANK_CATEGORIES, type BankCategoryKey } from './bank-categories';

export type RuleField = 'narration' | 'reference' | 'amount';
export type RuleOp = 'equals' | 'contains' | 'starts_with' | 'ends_with' | 'not_contains' | 'greater_than' | 'less_than' | 'gte' | 'lte';
export interface RuleCriterion { field: RuleField; op: RuleOp; value: string }
export type RuleApplyTo = 'deposits' | 'withdrawals';
export type RuleMatchMode = 'any' | 'all';
export type RuleScope = 'all' | 'banks' | 'cards' | 'custom';

export const RULE_FIELDS: { value: RuleField; label: string }[] = [
  { value: 'narration', label: 'Description' },
  { value: 'reference', label: 'Reference#' },
  { value: 'amount', label: 'Amount' },
];
export const TEXT_OPS: { value: RuleOp; label: string }[] = [
  { value: 'equals', label: 'is' },
  { value: 'contains', label: 'contains' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with', label: 'ends with' },
  { value: 'not_contains', label: 'does not contain' },
];
export const AMOUNT_OPS: { value: RuleOp; label: string }[] = [
  { value: 'equals', label: 'is' },
  { value: 'greater_than', label: 'is greater than' },
  { value: 'less_than', label: 'is less than' },
  { value: 'gte', label: 'is greater than or equal to' },
  { value: 'lte', label: 'is less than or equal to' },
];
export const opsFor = (field: RuleField) => (field === 'amount' ? AMOUNT_OPS : TEXT_OPS);

export const MATCH_MODES: { value: RuleMatchMode; label: string }[] = [
  { value: 'any', label: 'Any one of the following criteria matches' },
  { value: 'all', label: 'All of the following criteria matches' },
];

/**
 * What a rule may record a line as: the categories that need only an account
 * (or the other account of a transfer). A customer's or vendor's payment needs
 * the invoices or bills it settles, which a rule cannot know, so those are
 * matched on the line itself.
 */
export const RULE_RECORD_AS: Record<RuleApplyTo, BankCategoryKey[]> = {
  deposits: ['transfer_from', 'sales_without_invoice', 'interest_income', 'other_income', 'expense_refund', 'deposit_from_other', 'owner_contribution'],
  withdrawals: ['expense', 'transfer_to', 'card_payment', 'owner_drawings', 'employee_reimbursement', 'deposit_to_other'],
};
export const recordAsOptions = (applyTo: RuleApplyTo) =>
  RULE_RECORD_AS[applyTo].map((k) => BANK_CATEGORIES.find((c) => c.key === k)!).filter(Boolean);

export const REFERENCE_MODES: { value: 'statement' | 'none'; label: string }[] = [
  { value: 'statement', label: 'From the bank statement' },
  { value: 'none', label: 'None' },
];

export interface RuleShape {
  applyTo: RuleApplyTo | null;
  matchMode: RuleMatchMode;
  scope: RuleScope;
  scopeAccountIds: number[] | null;
  criteria: RuleCriterion[];
}

export interface RuleLine {
  narration: string;
  reference: string | null;
  depositPaise: number;
  withdrawalPaise: number;
  bankAccountId: number;
  bankKind: string;
}

function meets(c: RuleCriterion, line: RuleLine): boolean {
  if (c.field === 'amount') {
    const amount = line.depositPaise || line.withdrawalPaise;
    const want = Math.round(Number(String(c.value).replace(/,/g, '')) * 100);
    if (!Number.isFinite(want)) return false;
    switch (c.op) {
      case 'equals': return amount === want;
      case 'greater_than': return amount > want;
      case 'less_than': return amount < want;
      case 'gte': return amount >= want;
      case 'lte': return amount <= want;
      default: return false;
    }
  }
  const hay = (c.field === 'reference' ? line.reference ?? '' : line.narration).toLowerCase().trim();
  const needle = String(c.value).toLowerCase().trim();
  if (!needle) return false;
  switch (c.op) {
    case 'equals': return hay === needle;
    case 'contains': return hay.includes(needle);
    case 'starts_with': return hay.startsWith(needle);
    case 'ends_with': return hay.endsWith(needle);
    case 'not_contains': return !hay.includes(needle);
    default: return false;
  }
}

/** Whether a rule catches a statement line: its direction, its accounts, then its criteria. */
export function ruleCatches(rule: RuleShape, line: RuleLine): boolean {
  const deposit = line.depositPaise > 0;
  if (rule.applyTo === 'deposits' && !deposit) return false;
  if (rule.applyTo === 'withdrawals' && deposit) return false;
  if (rule.scope === 'banks' && line.bankKind !== 'bank') return false;
  if (rule.scope === 'cards' && line.bankKind !== 'card') return false;
  if (rule.scope === 'custom' && !(rule.scopeAccountIds ?? []).includes(line.bankAccountId)) return false;
  const criteria = rule.criteria.filter((c) => c && c.field && c.op);
  if (!criteria.length) return false;
  return rule.matchMode === 'any' ? criteria.some((c) => meets(c, line)) : criteria.every((c) => meets(c, line));
}

/** The rule as stored (bank_rules) in the shape the matcher reads. */
export function ruleShapeOf(row: {
  apply_to: string | null; match_mode: string | null; account_scope: string | null; scope_account_ids: unknown;
  bank_account_id: number | null; conditions: unknown;
}): RuleShape {
  const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
  const ids = parse(row.scope_account_ids);
  const scopeIds = Array.isArray(ids) ? ids.map(Number) : null;
  // A rule from before migration 120 named at most one account and needed every criterion.
  const scope = (row.account_scope as RuleScope) ?? 'all';
  return {
    applyTo: row.apply_to === 'deposits' || row.apply_to === 'withdrawals' ? row.apply_to : null,
    matchMode: row.match_mode === 'any' ? 'any' : 'all',
    scope: scope === 'all' && row.bank_account_id ? 'custom' : scope,
    scopeAccountIds: scope === 'all' && row.bank_account_id ? [row.bank_account_id] : scopeIds,
    criteria: (parse(row.conditions) ?? []) as RuleCriterion[],
  };
}
