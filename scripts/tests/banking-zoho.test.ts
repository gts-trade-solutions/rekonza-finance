// Zoho Books' Banking, field for field: Add Bank or Credit Card (and Edit,
// Mark as Inactive, Delete), the overview's figures and chart, an account's
// "All Transactions" in the books, Add Transaction from an account, the
// transaction rules (Recognized or Categorized, any or all criteria, which
// accounts), Multi-Select & Match, and why a line was excluded
// (services/bank-accounts.ts, bank-overview.ts, bank-match.ts, bank-rules.ts).
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/banking-zoho.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { applyRecognized, applyRules, importStatement } from '../../lib/server/services/banking';
import { addBankAccount, deleteBankAccount, setBankAccountActive, updateBankAccount } from '../../lib/server/services/bank-accounts';
import { accountsWithFigures, balanceSeries, bookTransactions, chartPoints } from '../../lib/server/services/bank-overview';
import { addAccountTransaction, matchLinesTogether } from '../../lib/server/services/bank-match';
import { createRule } from '../../lib/server/services/bank-rules';
import { setExcluded } from '../../lib/server/services/bank-bulk';
import { ruleCatches, ruleShapeOf, type RuleShape } from '../../lib/bank-rules';

test.after(() => db.destroy());

// ── Which lines a rule catches, without a database ───────────────────────────

const line = (o: Partial<{ narration: string; reference: string | null; depositPaise: number; withdrawalPaise: number; bankAccountId: number; bankKind: string }> = {}) => ({
  narration: 'POS BHARAT PETRO FUEL', reference: 'TXN998', depositPaise: 0, withdrawalPaise: 50_000, bankAccountId: 1, bankKind: 'bank', ...o,
});
const rule = (o: Partial<RuleShape> = {}): RuleShape => ({
  applyTo: 'withdrawals', matchMode: 'any', scope: 'all', scopeAccountIds: null, criteria: [{ field: 'narration', op: 'contains', value: 'fuel' }], ...o,
});

test('a rule catches lines by direction, by account and by its criteria, any or all', () => {
  assert.equal(ruleCatches(rule(), line()), true, 'text is compared without case');
  assert.equal(ruleCatches(rule({ applyTo: 'deposits' }), line()), false, 'a deposits rule leaves a withdrawal alone');
  assert.equal(ruleCatches(rule(), line({ depositPaise: 50_000, withdrawalPaise: 0 })), false);
  assert.equal(ruleCatches(rule({ scope: 'cards' }), line()), false, 'All Cards leaves a bank account alone');
  assert.equal(ruleCatches(rule({ scope: 'banks' }), line()), true);
  assert.equal(ruleCatches(rule({ scope: 'custom', scopeAccountIds: [2] }), line()), false);
  assert.equal(ruleCatches(rule({ scope: 'custom', scopeAccountIds: [1, 2] }), line()), true);
  const two = [{ field: 'narration' as const, op: 'starts_with' as const, value: 'pos' }, { field: 'amount' as const, op: 'gte' as const, value: '1,000' }];
  assert.equal(ruleCatches(rule({ matchMode: 'any', criteria: two }), line()), true, 'any one: the narration starts with POS');
  assert.equal(ruleCatches(rule({ matchMode: 'all', criteria: two }), line()), false, 'all: ₹500 is not at least ₹1,000');
  assert.equal(ruleCatches(rule({ criteria: [{ field: 'amount', op: 'equals', value: '500' }] }), line()), true, 'an amount is typed in rupees');
  assert.equal(ruleCatches(rule({ criteria: [{ field: 'reference', op: 'ends_with', value: '998' }] }), line()), true);
  assert.equal(ruleCatches(rule({ criteria: [{ field: 'narration', op: 'not_contains', value: 'petro' }] }), line()), false);
  assert.equal(ruleCatches(rule({ criteria: [] }), line()), false, 'a rule with no criteria catches nothing');
  // A rule from before migration 120: every criterion, both directions, the one account it named.
  const old = ruleShapeOf({ apply_to: null, match_mode: 'all', account_scope: 'all', scope_account_ids: null, bank_account_id: 7, conditions: '[{"field":"narration","op":"contains","value":"FUEL"}]' });
  assert.deepEqual([old.applyTo, old.scope, old.scopeAccountIds], [null, 'custom', [7]]);
  assert.equal(ruleCatches(old, line({ bankAccountId: 7, depositPaise: 10, withdrawalPaise: 0 })), true);
});

test('the chart is drawn at each of the last 30 days, or at each of the last 12 month ends', () => {
  const days = chartPoints('30d', '2026-11-23');
  assert.equal(days.length, 30);
  assert.deepEqual([days[0], days[29]], ['2026-10-25', '2026-11-23']);
  const months = chartPoints('12m', '2026-11-23');
  assert.equal(months.length, 12);
  assert.deepEqual([months[0], months[10], months[11]], ['2025-12-31', '2026-10-31', '2026-11-23'], 'this month ends today');
});

// ── With a book ──────────────────────────────────────────────────────────────

interface Fixture { trx: Trx; orgId: number; branchId: number; customerId: number; vendorId: number; bankId: number; cashId: number; acc: Record<string, number> }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Zoho Banking Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const mk = async (v: Record<string, unknown>) => Number((await trx.insertInto('contacts').values(v as never).executeTakeFirstOrThrow()).insertId);
      const customerId = await mk({ org_id: orgId, kind: 'customer', display_name: 'Bonita Skin Care', gst_treatment: 'registered', state_code: '33' });
      const vendorId = await mk({ org_id: orgId, kind: 'vendor', display_name: 'Petro Fuels', gst_treatment: 'unregistered', state_code: '33' });
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'ICICI Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000', is_primary: 1,
      }).executeTakeFirstOrThrow()).insertId);
      const cashId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'cash', name: 'Cash in Hand', ledger_account_id: acc[CODE.CASH], opening_balance: '0.0000',
      }).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, customerId, vendorId, bankId, cashId, acc: acc as unknown as Record<string, number> });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test('Add Bank or Credit Card keeps Zoho’s fields; Edit renames the ledger account; inactive and delete are guarded', async () => {
  await withFixture(async (f) => {
    await assert.rejects(addBankAccount(f.trx, f.orgId, null, { kind: 'bank', name: '  ' }), /Please enter a valid account name\./);
    await assert.rejects(addBankAccount(f.trx, f.orgId, null, { kind: 'bank', name: 'HDFC', ifsc: 'HDFC1234' }), /IFSC is 11 characters/);
    await assert.rejects(addBankAccount(f.trx, f.orgId, null, { kind: 'bank', name: 'ICICI Current' }), /already exists/);
    const hdfc = await addBankAccount(f.trx, f.orgId, null, {
      kind: 'bank', name: 'HDFC Current', accountCode: 'B-01', currency: 'usd', accountNumber: '5010 0123 4567 89', bankName: 'HDFC Bank',
      ifsc: 'hdfc0001234', description: 'Collections', userIds: [99, 99], isPrimary: true,
    });
    const row = await f.trx.selectFrom('bank_accounts').selectAll().where('id', '=', hdfc.id).executeTakeFirstOrThrow();
    assert.deepEqual([row.account_code, row.currency, row.account_number, row.account_last4, row.ifsc, row.is_primary], ['B-01', 'USD', '50100123456789', '6789', 'HDFC0001234', 1]);
    assert.deepEqual(typeof row.user_ids === 'string' ? JSON.parse(row.user_ids) : row.user_ids, [99]);
    const icici = await f.trx.selectFrom('bank_accounts').select('is_primary').where('id', '=', f.bankId).executeTakeFirstOrThrow();
    assert.equal(icici.is_primary, 0, 'one primary account at a time');
    const card = await addBankAccount(f.trx, f.orgId, null, { kind: 'card', name: 'Amex', accountNumber: '3782 822463 10005', ifsc: 'HDFC0001234' });
    const cardRow = await f.trx.selectFrom('bank_accounts').select(['account_number', 'ifsc', 'kind']).where('id', '=', card.id).executeTakeFirstOrThrow();
    assert.deepEqual([cardRow.kind, cardRow.account_number, cardRow.ifsc], ['card', null, null], 'a card has no account number or IFSC');

    // Who may see it: the users chosen, and admins.
    const seen = async (viewer: { userId: number; role: 'admin' | 'accountant' }) =>
      (await accountsWithFigures(f.trx, f.orgId, { viewer })).some((a) => a.id === hdfc.id);
    assert.equal(await seen({ userId: 5, role: 'accountant' }), false);
    assert.equal(await seen({ userId: 99, role: 'accountant' }), true);
    assert.equal(await seen({ userId: 5, role: 'admin' }), true);

    await updateBankAccount(f.trx, f.orgId, hdfc.id, { name: 'HDFC Collections', currency: 'INR', isPrimary: false, userIds: [] });
    const ledger = await f.trx.selectFrom('accounts').select('name').where('id', '=', hdfc.ledgerAccountId).executeTakeFirstOrThrow();
    assert.equal(ledger.name, 'HDFC Collections', 'the chart says what the account is called too');

    // Inactive: not while statement lines wait; Delete: not once anything is posted.
    await importStatement(f.trx, f.orgId, null, hdfc.id, 'nov.csv', [{ date: '2026-11-02', narration: 'NEFT CR BONITA', depositPaise: 10_000 }]);
    await assert.rejects(setBankAccountActive(f.trx, f.orgId, hdfc.id, false), /uncategorized statement lines/);
    await assert.rejects(deleteBankAccount(f.trx, f.orgId, hdfc.id), /has transactions/);
    const r = await setBankAccountActive(f.trx, f.orgId, card.id, false);
    assert.equal(r.isActive, false);
    assert.equal((await accountsWithFigures(f.trx, f.orgId)).some((a) => a.id === card.id), false, 'an inactive account leaves the active list');
    assert.equal((await accountsWithFigures(f.trx, f.orgId, { status: 'inactive' })).some((a) => a.id === card.id), true);
    await deleteBankAccount(f.trx, f.orgId, card.id);
    assert.equal(await f.trx.selectFrom('bank_accounts').select('id').where('id', '=', card.id).executeTakeFirst(), undefined);
    assert.equal(await f.trx.selectFrom('accounts').select('id').where('id', '=', card.ledgerAccountId).executeTakeFirst(), undefined, 'its ledger account goes with it');
  });
});

test('the overview: what the books hold, what the bank last said, what waits, and the balance day by day', async () => {
  await withFixture(async (f) => {
    await importStatement(f.trx, f.orgId, null, f.bankId, 'nov.csv', [
      { date: '2026-11-03', narration: 'NEFT CR BONITA', depositPaise: 50_000, runningBalancePaise: 150_000 },
      { date: '2026-11-04', narration: 'ATM WDL', withdrawalPaise: 20_000, runningBalancePaise: 130_000 },
    ]);
    // The owner puts in ₹1,000 on 10 November, entered on the account (Add Transaction).
    const added = await addAccountTransaction(f.trx, f.orgId, null, f.bankId, {
      kind: 'owner_contribution', date: '2026-11-10', amountPaise: 100_000, accountId: f.acc[CODE.CAPITAL], notes: 'Capital brought in',
    });
    assert.equal(added.created, null);
    const icici = (await accountsWithFigures(f.trx, f.orgId)).find((a) => a.id === f.bankId)!;
    assert.deepEqual([icici.amountInBooksPaise, icici.amountInBankPaise, icici.amountInBankOn, icici.uncategorized], [100_000, 130_000, '2026-11-04', 2]);

    const { points, series } = await balanceSeries(f.trx, f.orgId, [icici], '30d', '2026-11-23');
    assert.equal(series.bank[points.indexOf('2026-11-09')], 0);
    assert.equal(series.bank[points.indexOf('2026-11-10')], 100_000, 'the balance moves on the day it was posted');
    assert.equal(series.bank[29], 100_000, 'and is carried forward');
    assert.equal(series.card[29], 0);

    const books = await bookTransactions(f.trx, f.orgId, f.bankId);
    assert.equal(books.transactions.length, 1);
    assert.deepEqual([books.transactions[0].type, books.transactions[0].status, books.transactions[0].runningBalancePaise],
      ["Owner's Contribution", 'Manually Added', 100_000], 'typed in on the account, and no statement line claims it yet');
    assert.equal((await verifyLedgerBalances(f.trx, f.orgId)).balanced, true);
  });
});

test('Add Transaction records an expense, a transfer and a deposit through the account, as Zoho does', async () => {
  await withFixture(async (f) => {
    const exp = await addAccountTransaction(f.trx, f.orgId, null, f.bankId, {
      kind: 'expense', date: '2026-11-12', amountPaise: 11_800, accountId: f.acc[CODE.FUEL], contactId: f.vendorId, gstRatePct: 0, reference: 'FUEL-12',
    });
    assert.match(exp.created ?? '', /EXP/);
    const expense = await f.trx.selectFrom('expenses').select(['id', 'paid_through_bank_account_id']).where('org_id', '=', f.orgId).executeTakeFirstOrThrow();
    assert.equal(expense.paid_through_bank_account_id, f.bankId, 'paid from this account');
    await addAccountTransaction(f.trx, f.orgId, null, f.bankId, { kind: 'transfer_to', date: '2026-11-13', amountPaise: 5_000, otherBankAccountId: f.cashId });
    assert.equal((await f.trx.selectFrom('bank_transfers').select('id').where('org_id', '=', f.orgId).execute()).length, 1);
    await assert.rejects(addAccountTransaction(f.trx, f.orgId, null, f.bankId, { kind: 'expense', date: '2026-11-13', amountPaise: 0, accountId: f.acc[CODE.FUEL] }), /above zero/);
    await assert.rejects(addAccountTransaction(f.trx, f.orgId, null, f.bankId, { kind: 'deposit_from_other', date: '2026-11-13', amountPaise: 100 }), /Choose the account/);
    await assert.rejects(addAccountTransaction(f.trx, f.orgId, null, f.bankId, { kind: 'retainer_payment', date: '2026-11-13', amountPaise: 100, contactId: f.customerId }), /retainer invoice/);
    const books = await bookTransactions(f.trx, f.orgId, f.bankId);
    assert.deepEqual(books.transactions.map((t) => t.type).sort(), ['Expense', 'Transfer Fund']);
    assert.equal(books.closingPaise, -16_800);
    assert.equal((await verifyLedgerBalances(f.trx, f.orgId)).balanced, true);
  });
});

test('rules: Recognized lines wait for a person, Categorized ones are recorded, and a rule is checked before it is saved', async () => {
  await withFixture(async (f) => {
    const base = { matchMode: 'any' as const, referenceMode: 'statement' as const, scope: 'all' as const, criteria: [{ field: 'narration' as const, op: 'contains' as const, value: 'petro' }] };
    await assert.rejects(createRule(f.trx, f.orgId, { ...base, name: 'R', applyTo: 'deposits', markAs: 'recognized', recordAs: 'expense', accountId: f.acc[CODE.FUEL] }), /how to record/);
    await assert.rejects(createRule(f.trx, f.orgId, { ...base, name: 'R', applyTo: 'withdrawals', markAs: 'recognized', recordAs: 'deposit_to_other', accountId: f.acc[CODE.AP] }), /control account/);
    await assert.rejects(createRule(f.trx, f.orgId, { ...base, name: 'R', applyTo: 'withdrawals', markAs: 'recognized', recordAs: 'expense', accountId: f.acc[CODE.FUEL], scope: 'custom', scopeAccountIds: [] }), /Choose the accounts/);
    const fuel = await createRule(f.trx, f.orgId, { ...base, name: 'Fuel', applyTo: 'withdrawals', markAs: 'recognized', recordAs: 'expense', accountId: f.acc[CODE.FUEL], scope: 'banks' });
    await createRule(f.trx, f.orgId, {
      ...base, name: 'Charges', applyTo: 'withdrawals', markAs: 'categorized', recordAs: 'expense', accountId: f.acc[CODE.BANK_CHARGES],
      criteria: [{ field: 'narration', op: 'starts_with', value: 'bank charges' }],
    });
    await importStatement(f.trx, f.orgId, null, f.bankId, 'nov.csv', [
      { date: '2026-11-05', narration: 'POS BHARAT PETRO', withdrawalPaise: 4_500 },
      { date: '2026-11-06', narration: 'BANK CHARGES QTR', withdrawalPaise: 590 },
      { date: '2026-11-07', narration: 'PETRO REFUND', depositPaise: 300 },
    ]);
    await applyRules(f.trx, f.orgId, null, f.bankId);
    const lines = await f.trx.selectFrom('bank_transactions').select(['id', 'narration', 'status', 'applied_rule_id']).where('org_id', '=', f.orgId).orderBy('id').execute();
    const [petro, charges, refund] = lines;
    assert.deepEqual([petro.status, petro.applied_rule_id], ['unmatched', fuel], 'recognized, still waiting');
    assert.equal(charges.status, 'matched', 'categorized outright');
    assert.deepEqual([refund.status, refund.applied_rule_id], ['unmatched', null], 'a withdrawals rule leaves a deposit alone');
    const r = await applyRecognized(f.trx, f.orgId, null, [petro.id, refund.id]);
    assert.deepEqual(r, { applied: 1, skipped: 1 });
    const done = await f.trx.selectFrom('bank_transactions').select(['status', 'matched_type']).where('id', '=', petro.id).executeTakeFirstOrThrow();
    assert.deepEqual([done.status, done.matched_type], ['matched', 'expense'], 'recorded as the rule says: an expense');
    assert.equal((await verifyLedgerBalances(f.trx, f.orgId)).balanced, true);
  });
});

test('Multi-Select & Match: lines that add up to one transaction in the books are matched to it together', async () => {
  await withFixture(async (f) => {
    await addAccountTransaction(f.trx, f.orgId, null, f.bankId, { kind: 'expense', date: '2026-11-10', amountPaise: 100_000, accountId: f.acc[CODE.FUEL], gstRatePct: 0 });
    const expense = await f.trx.selectFrom('expenses').select('id').where('org_id', '=', f.orgId).executeTakeFirstOrThrow();
    await importStatement(f.trx, f.orgId, null, f.bankId, 'nov.csv', [
      { date: '2026-11-10', narration: 'CARD SPEND PART 1', withdrawalPaise: 60_000 },
      { date: '2026-11-11', narration: 'CARD SPEND PART 2', withdrawalPaise: 40_000 },
      { date: '2026-11-11', narration: 'SOMETHING ELSE', withdrawalPaise: 30_000 },
    ]);
    const ids = (await f.trx.selectFrom('bank_transactions').select('id').where('org_id', '=', f.orgId).orderBy('id').execute()).map((r) => r.id);
    await assert.rejects(matchLinesTogether(f.trx, f.orgId, null, [ids[0], ids[2]], { type: 'expense', id: expense.id }), /add up to 900\.00/);
    await assert.rejects(matchLinesTogether(f.trx, f.orgId, null, [ids[0]], { type: 'expense', id: expense.id }), /two or more/);
    const r = await matchLinesTogether(f.trx, f.orgId, null, [ids[0], ids[1]], { type: 'expense', id: expense.id });
    assert.equal(r.matched, 2);
    const links = await f.trx.selectFrom('bank_transaction_links').select(['target_type', 'target_id', 'amount']).where('org_id', '=', f.orgId).execute();
    assert.equal(links.length, 2);
    assert.ok(links.every((l) => l.target_type === 'expense' && l.target_id === expense.id));
    const books = await bookTransactions(f.trx, f.orgId, f.bankId);
    assert.equal(books.transactions[0].status, 'Matched', 'the expense is claimed by its statement lines');
    assert.equal((await f.trx.selectFrom('journal_entries').select('id').where('org_id', '=', f.orgId).execute()).length, 1, 'matching posted nothing more');
  });
});

test('an excluded line keeps why, and restoring it clears that', async () => {
  await withFixture(async (f) => {
    await importStatement(f.trx, f.orgId, null, f.bankId, 'nov.csv', [{ date: '2026-11-03', narration: 'DUPLICATE ROW', depositPaise: 500 }]);
    const { id } = await f.trx.selectFrom('bank_transactions').select('id').where('org_id', '=', f.orgId).executeTakeFirstOrThrow();
    assert.equal(await setExcluded(f.trx, f.orgId, [id], true, 'Shown twice in the statement'), 1);
    let row = await f.trx.selectFrom('bank_transactions').select(['status', 'exclude_reason']).where('id', '=', id).executeTakeFirstOrThrow();
    assert.deepEqual([row.status, row.exclude_reason], ['excluded', 'Shown twice in the statement']);
    await setExcluded(f.trx, f.orgId, [id], false);
    row = await f.trx.selectFrom('bank_transactions').select(['status', 'exclude_reason']).where('id', '=', id).executeTakeFirstOrThrow();
    assert.deepEqual([row.status, row.exclude_reason], ['unmatched', null]);
    await setExcluded(f.trx, f.orgId, [id], true);
    row = await f.trx.selectFrom('bank_transactions').select(['status', 'exclude_reason']).where('id', '=', id).executeTakeFirstOrThrow();
    assert.equal(row.exclude_reason, 'Excluded manually');
  });
});
