import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Zoho Books' Banking → More → Preferences, the options Rekonza acts on
// (migration 125):
//   - run the transaction rules on a statement as it comes in;
//   - match lines to payments and invoices as it comes in;
//   - how many days apart a payment entered and its statement line may be and
//     still be matched (and still count as close in Best Matches);
//   - the expense and income accounts Categorize Manually offers first;
//   - whether the Payment Clearing tile shows on the overview;
//   - keep a line that repeats one already imported as "Automatically
//     Excluded" (restorable) rather than dropping it;
//   - accept statements forwarded by email, and from whom.
// No row means the defaults: what Rekonza did before the preferences existed.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import { badRequest } from '../http';

export interface BankingPreferences {
  applyRulesOnImport: boolean;
  autoMatchOnImport: boolean;
  matchWindowDays: number;
  defaultExpenseAccountId: string | null;
  defaultIncomeAccountId: string | null;
  showPaymentClearing: boolean;
  keepDuplicates: boolean;
  inboundEnabled: boolean;
  /** Addresses (or @domains) besides the organisation's own users that may forward statements. */
  inboundSenders: string[];
}

export const DEFAULT_BANKING_PREFERENCES: BankingPreferences = {
  applyRulesOnImport: true, autoMatchOnImport: true, matchWindowDays: 3, defaultExpenseAccountId: null,
  defaultIncomeAccountId: null, showPaymentClearing: true, keepDuplicates: true, inboundEnabled: true, inboundSenders: [],
};

const senders = (raw: string | null | undefined) => (raw ?? '').split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);

export async function bankingPreferences(ex: Executor, orgId: number): Promise<BankingPreferences> {
  const r = await ex.selectFrom('banking_preferences').selectAll().where('org_id', '=', orgId).executeTakeFirst();
  if (!r) return { ...DEFAULT_BANKING_PREFERENCES };
  return {
    applyRulesOnImport: !!r.apply_rules_on_import,
    autoMatchOnImport: !!r.auto_match_on_import,
    matchWindowDays: Number(r.match_window_days),
    defaultExpenseAccountId: r.default_expense_account_id ? String(r.default_expense_account_id) : null,
    defaultIncomeAccountId: r.default_income_account_id ? String(r.default_income_account_id) : null,
    showPaymentClearing: !!r.show_payment_clearing,
    keepDuplicates: !!r.keep_duplicates,
    inboundEnabled: !!r.inbound_enabled,
    inboundSenders: senders(r.inbound_senders),
  };
}

export async function saveBankingPreferences(trx: Trx, orgId: number, input: Partial<BankingPreferences>): Promise<BankingPreferences> {
  const cur = await bankingPreferences(trx, orgId);
  const next = { ...cur, ...input };
  if (!(Number.isInteger(next.matchWindowDays) && next.matchWindowDays >= 0 && next.matchWindowDays <= 30)) {
    throw badRequest('Match payments within 0 to 30 days of the statement line.');
  }
  for (const [label, id, types] of [
    ['expense', next.defaultExpenseAccountId, ['expense', 'asset']],
    ['income', next.defaultIncomeAccountId, ['income']],
  ] as const) {
    if (!id) continue;
    const a = await trx.selectFrom('accounts').select(['id', 'type']).where('id', '=', Number(id)).where('org_id', '=', orgId).executeTakeFirst();
    if (!a) throw badRequest(`The default ${label} account does not exist.`);
    if (!(types as readonly string[]).includes(a.type)) throw badRequest(`Choose an ${label} account for the default ${label} account.`);
  }
  const list = next.inboundSenders.map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const s of list) {
    if (!/^(@[a-z0-9.-]+\.[a-z]{2,}|[^\s@]+@[a-z0-9.-]+\.[a-z]{2,})$/.test(s)) throw badRequest(`"${s}" is not an email address or an @domain.`);
  }
  const values = {
    apply_rules_on_import: next.applyRulesOnImport ? 1 : 0,
    auto_match_on_import: next.autoMatchOnImport ? 1 : 0,
    match_window_days: next.matchWindowDays,
    default_expense_account_id: next.defaultExpenseAccountId ? Number(next.defaultExpenseAccountId) : null,
    default_income_account_id: next.defaultIncomeAccountId ? Number(next.defaultIncomeAccountId) : null,
    show_payment_clearing: next.showPaymentClearing ? 1 : 0,
    keep_duplicates: next.keepDuplicates ? 1 : 0,
    inbound_enabled: next.inboundEnabled ? 1 : 0,
    inbound_senders: list.join(', ').slice(0, 1000) || null,
  };
  await trx.insertInto('banking_preferences').values({ org_id: orgId, ...values })
    .onDuplicateKeyUpdate(values).execute();
  return { ...next, inboundSenders: list };
}
