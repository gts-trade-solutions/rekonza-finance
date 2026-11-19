// Budget against actual (lib/server/reports/budgets.ts): the budget to date,
// a variance that is favourable when spending is under or income is over, the
// months from April, and actuals narrowed to a cost centre.

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { postEntry } from '../../lib/server/ledger/posting';
import { budgetVsActual } from '../../lib/server/reports/budgets';

async function withBook(fn: (trx: Trx, orgId: number, branchId: number, acc: Map<string, number>) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Budget Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AABCB3131B1Z2' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const rows = await trx.selectFrom('accounts').select(['id', 'code', 'type']).where('org_id', '=', orgId).execute();
      await fn(trx, orgId, branchId, new Map(rows.map((r) => [r.code, Number(r.id)])));
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test('budget to date, favourable or adverse by account type, month by month, by cost centre', async () => {
  await withBook(async (trx, orgId, branchId, acc) => {
    const rentId = acc.get('6100') ?? [...acc.entries()].find(([c]) => c.startsWith('6'))![1];
    const salesId = acc.get(CODE.SALES)!;
    const bankId = acc.get(CODE.BANK_DEFAULT)!;
    const centre = Number((await trx.insertInto('cost_centres').values({ org_id: orgId, code: 'CHN', name: 'Chennai' }).executeTakeFirstOrThrow()).insertId);
    // A year's rent budget of ₹3,65,000 (₹1,000 a day) and a sales target of ₹7,30,000 (₹2,000 a day).
    await trx.insertInto('budgets').values([
      { org_id: orgId, fy_label: '2026-27', account_id: rentId, branch_id: 0, amount: '365000.0000' },
      { org_id: orgId, fy_label: '2026-27', account_id: salesId, branch_id: 0, amount: '730000.0000' },
    ]).execute();
    const post = (date: string, account: number, dr: number, cr: number, cc: number | null = null) => postEntry(trx, {
      orgId, branchId, date, sourceType: 'manual', userId: null, module: 'accountant', memo: 'test',
      lines: [
        { accountId: account, debit: dr as never, credit: cr as never, costCentreId: cc },
        { accountId: bankId, debit: cr as never, credit: dr as never },
      ],
    });
    // April and May: rent ₹50,000 (₹40,000 of it Chennai's), sales ₹1,50,000.
    await post('2026-04-10', rentId, 30_000_00, 0, centre);
    await post('2026-05-10', rentId, 20_000_00, 0);
    await trx.updateTable('journal_lines').set({ cost_centre_id: centre }).where('org_id', '=', orgId).where('account_id', '=', rentId).where('entry_date', '=', '2026-05-10').execute();
    await post('2026-05-15', salesId, 0, 1_50_000_00);
    const r = await budgetVsActual(trx, orgId, { fy: '2026-27', asOf: '2026-05-31', today: '2026-05-31' });
    assert.deepEqual(r.months, ['2026-04', '2026-05']);
    const rent = r.rows.find((x) => x.accountId === String(rentId))!;
    const sales = r.rows.find((x) => x.accountId === String(salesId))!;
    // 61 days gone: ₹61,000 of rent budgeted to date, ₹50,000 spent: ₹11,000 favourable.
    assert.equal(rent.budgetToDatePaise, 61_000_00);
    assert.equal(rent.varianceToDatePaise, 11_000_00);
    assert.ok(rent.favourable);
    assert.equal(rent.months[0].budgetPaise, 30_000_00, 'April has 30 days: ₹30,000');
    assert.equal(rent.months[0].actualPaise, 30_000_00);
    // Sales ₹1,22,000 to date expected, ₹1,50,000 earned: ₹28,000 favourable; a shortfall would be adverse.
    assert.equal(sales.budgetToDatePaise, 1_22_000_00);
    assert.equal(sales.varianceToDatePaise, 28_000_00);
    assert.ok(sales.favourable);
    assert.equal(sales.variancePaise, 7_30_000_00 - 1_50_000_00, 'budget less actual is still what is left');
    // Narrowed to the cost centre: only its ₹50,000 of rent (both entries were tagged), no sales.
    const cc = await budgetVsActual(trx, orgId, { fy: '2026-27', asOf: '2026-05-31', today: '2026-05-31', costCentreId: centre });
    assert.equal(cc.rows.find((x) => x.accountId === String(rentId))!.actualPaise, 50_000_00);
    const ccSales = cc.rows.find((x) => x.accountId === String(salesId))!;
    assert.equal(ccSales.actualPaise, 0);
    assert.ok(!ccSales.favourable, 'no sales against a sales target is adverse');
  });
});

test.after(() => db.destroy());
