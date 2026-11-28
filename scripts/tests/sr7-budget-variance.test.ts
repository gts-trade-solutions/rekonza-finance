// Budgets by period and Budget vs Actuals (status review 7, item 12): named
// budgets entered monthly, quarterly, half-yearly or yearly; edit, clone and
// delete; fill from last year's actuals with a percentage; the report per
// account and column with variance in rupees and per cent, favourable or not,
// a threshold flag and group totals that tie to the profit and loss; a cost
// centre budget for costing; and the old yearly budgets read as before.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/sr7-budget-variance.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { postEntry } from '../../lib/server/ledger/posting';
import { profitAndLoss } from '../../lib/server/reports/statements';
import { budgetVsActual } from '../../lib/server/reports/budgets';
import {
  actualsForPlan, budgetFor, budgetVsActuals, clonePlan, costCentreSummary, deletePlan, getPlan, listPlans, planPeriods, savePlan,
} from '../../lib/server/reports/budget-plans';

interface F { trx: Trx; orgId: number; branchId: number; acc: Record<string, number>; centre: number }

async function withBook(fn: (f: F) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Budget Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const centre = Number((await trx.insertInto('cost_centres').values({ org_id: orgId, code: 'CHN', name: 'Chennai showroom' }).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, acc: await accountIds(trx, orgId), centre });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const post = (f: F, date: string, account: string, dr: number, cr: number, cc: number | null = null) => postEntry(f.trx, {
  orgId: f.orgId, branchId: f.branchId, date, sourceType: 'manual', userId: null, module: 'accountant', memo: 'test',
  lines: [
    { accountId: f.acc[account], debit: dr * 100, credit: cr * 100, costCentreId: cc },
    { accountId: f.acc[CODE.BANK_DEFAULT], debit: cr * 100, credit: dr * 100 },
  ],
});

const monthly = (rupees: number[]) => rupees.map((r) => r * 100);

test('periods: twelve months, four quarters, two halves or one year, April to March', () => {
  const m = planPeriods('2026-27', 'monthly');
  assert.equal(m.length, 12);
  assert.deepEqual([m[0].from, m[0].to, m[0].label], ['2026-04-01', '2026-04-30', 'Apr 2026']);
  assert.deepEqual([m[11].from, m[11].to], ['2027-03-01', '2027-03-31']);
  const q = planPeriods('2026-27', 'quarterly');
  assert.deepEqual(q.map((x) => [x.from, x.to]), [['2026-04-01', '2026-06-30'], ['2026-07-01', '2026-09-30'], ['2026-10-01', '2026-12-31'], ['2027-01-01', '2027-03-31']]);
  assert.deepEqual(planPeriods('2026-27', 'half_yearly').map((x) => x.label), ['H1 (Apr–Sep)', 'H2 (Oct–Mar)']);
  assert.deepEqual(planPeriods('2026-27', 'yearly').map((x) => [x.from, x.to]), [['2026-04-01', '2027-03-31']]);
  // A yearly ₹3,65,000 read for April is ₹30,000 (30 of 365 days), as the old yearly budgets were spread.
  assert.equal(budgetFor([3_65_000_00], planPeriods('2026-27', 'yearly'), '2026-04-01', '2026-04-30'), 30_000_00);
  // A quarterly amount read monthly: April gets 30 of the quarter's 91 days.
  assert.equal(budgetFor([91_000_00, 0, 0, 0], planPeriods('2026-27', 'quarterly'), '2026-04-01', '2026-04-30'), 30_000_00);
});

test('a monthly budget is saved, edited, cloned with +10%, and deleted; mistakes are refused plainly', async () => {
  await withBook(async (f) => {
    const id = await savePlan(f.trx, f.orgId, null, {
      name: 'Original', fyLabel: '2026-27', period: 'monthly',
      lines: [
        { accountId: f.acc[CODE.SALES], amountsPaise: monthly(Array(12).fill(1_00_000)) },
        { accountId: f.acc[CODE.RENT], amountsPaise: monthly(Array(12).fill(20_000)) },
      ],
    });
    const p = await getPlan(f.trx, f.orgId, id);
    assert.equal(p.periods.length, 12);
    assert.equal(p.lines.find((l) => l.code === CODE.RENT)!.amountsPaise[5], 20_000_00);
    assert.equal(p.isPrimary, true, 'the first whole-business budget of a year is its primary one');
    // The primary budget is also the year's figures in the old table the assistant reads.
    const legacy = await f.trx.selectFrom('budgets').select(['account_id', 'amount']).where('org_id', '=', f.orgId).execute();
    assert.equal(Number(legacy.find((r) => r.account_id === f.acc[CODE.RENT])!.amount), 2_40_000);
    // Edit: June's rent raised.
    const june = monthly(Array(12).fill(20_000)); june[2] = 25_000_00 / 100 * 1;
    await savePlan(f.trx, f.orgId, null, { id, name: 'Original', fyLabel: '2026-27', period: 'monthly', lines: [
      { accountId: f.acc[CODE.SALES], amountsPaise: monthly(Array(12).fill(1_00_000)) },
      { accountId: f.acc[CODE.RENT], amountsPaise: june.map((x, i) => (i === 2 ? 25_000_00 : x)) },
    ] });
    assert.equal((await getPlan(f.trx, f.orgId, id)).lines.find((l) => l.code === CODE.RENT)!.amountsPaise[2], 25_000_00);
    // Clone as "Revised", every amount 10% higher; several budgets for one year.
    const revised = await clonePlan(f.trx, f.orgId, null, id, { name: 'Revised', adjustPct: 10 });
    const r = await getPlan(f.trx, f.orgId, revised);
    assert.equal(r.lines.find((l) => l.code === CODE.SALES)!.amountsPaise[0], 1_10_000_00);
    assert.equal(r.isPrimary, false);
    assert.deepEqual((await listPlans(f.trx, f.orgId, '2026-27')).map((x) => x.name).sort(), ['Original', 'Revised']);
    // Refusals.
    await assert.rejects(savePlan(f.trx, f.orgId, null, { name: 'Original', fyLabel: '2026-27', period: 'monthly', lines: [] }), /already a budget called Original/);
    await assert.rejects(savePlan(f.trx, f.orgId, null, { name: 'BS', fyLabel: '2026-27', period: 'yearly', lines: [{ accountId: f.acc[CODE.AR], amountsPaise: [100] }] }), /balance sheet account/);
    await assert.rejects(savePlan(f.trx, f.orgId, null, { name: 'Two', fyLabel: '2026-27', period: 'yearly', branchId: f.branchId, costCentreId: f.centre, lines: [] }), /choose one/);
    await assert.rejects(savePlan(f.trx, f.orgId, null, { name: 'Short', fyLabel: '2026-27', period: 'quarterly', lines: [{ accountId: f.acc[CODE.RENT], amountsPaise: [1, 2] }] }), /needs 4 amounts/);
    // Assets and liabilities when asked for.
    await savePlan(f.trx, f.orgId, null, { name: 'With BS', fyLabel: '2026-27', period: 'yearly', includeBalanceSheet: true, lines: [{ accountId: f.acc[CODE.AR], amountsPaise: [1_00_000_00] }] });
    // Delete.
    await deletePlan(f.trx, f.orgId, revised);
    assert.ok(!(await listPlans(f.trx, f.orgId, '2026-27')).some((x) => x.name === 'Revised'));
  });
});

test('Budget vs Actuals: per account and month, variance ₹ and %, favourable by type, threshold, group totals tie to the P&L', async () => {
  await withBook(async (f) => {
    const id = await savePlan(f.trx, f.orgId, null, {
      name: 'Original', fyLabel: '2026-27', period: 'monthly',
      lines: [
        { accountId: f.acc[CODE.SALES], amountsPaise: monthly(Array(12).fill(1_00_000)) },
        { accountId: f.acc[CODE.PURCHASES], amountsPaise: monthly(Array(12).fill(60_000)) },
        { accountId: f.acc[CODE.RENT], amountsPaise: monthly(Array(12).fill(20_000)) },
      ],
    });
    // April: sales ₹1,20,000 (20% over: favourable), purchases ₹60,000 (on budget), rent ₹25,000 (25% over: unfavourable).
    await post(f, '2026-04-10', CODE.SALES, 0, 1_20_000);
    await post(f, '2026-04-12', CODE.PURCHASES, 60_000, 0);
    await post(f, '2026-04-15', CODE.RENT, 25_000, 0);
    // May: sales ₹95,000 (5% under: unfavourable, inside a 10% threshold); an unbudgeted ₹3,000 of utilities.
    await post(f, '2026-05-10', CODE.SALES, 0, 95_000);
    await post(f, '2026-05-20', CODE.UTILITIES, 3_000, 0);
    const r = await budgetVsActuals(f.trx, f.orgId, id, { today: '2026-05-31', upto: '2026-05-31', thresholdPct: 10 });
    assert.deepEqual(r.columns.map((c) => c.label), ['Apr 2026', 'May 2026']);
    const row = (code: string) => r.sections.flatMap((s) => s.rows).find((x) => x.code === code)!;
    const sales = row(CODE.SALES);
    assert.deepEqual([sales.cells[0].budgetPaise, sales.cells[0].actualPaise, sales.cells[0].variancePaise, sales.cells[0].variancePct], [1_00_000_00, 1_20_000_00, 20_000_00, 20]);
    assert.equal(sales.cells[0].favourable, true, 'income above budget is favourable');
    assert.equal(sales.cells[0].flagged, true, '20% is beyond the 10% threshold');
    assert.equal(sales.cells[1].favourable, false, 'income below budget is unfavourable');
    assert.equal(sales.cells[1].flagged, false, '5% is inside the threshold');
    const rent = row(CODE.RENT);
    assert.equal(rent.cells[0].variancePct, 25);
    assert.equal(rent.cells[0].favourable, false, 'an expense above budget is unfavourable');
    assert.equal(rent.cells[1].favourable, true, 'nothing spent against ₹20,000 is favourable');
    const util = row(CODE.UTILITIES);
    assert.equal(util.budgeted, false, 'an unbudgeted account with actuals is shown, so the totals tie');
    assert.equal(util.total.actualPaise, 3_000_00);
    // Totals: sections and the profit lines.
    const income = r.sections.find((s) => s.key === 'income')!;
    assert.equal(income.total.total.budgetPaise, 2_00_000_00);
    assert.equal(income.total.total.actualPaise, 2_15_000_00);
    const gross = r.summary.find((s) => s.key === 'gross')!;
    assert.equal(gross.total.actualPaise, 2_15_000_00 - 60_000_00);
    assert.equal(gross.total.budgetPaise, 2_00_000_00 - 1_20_000_00);
    const net = r.summary.find((s) => s.key === 'net')!;
    const pl = await profitAndLoss(f.trx, f.orgId, '2026-04-01', '2026-05-31');
    assert.equal(net.total.actualPaise, pl.netProfit, 'net profit agrees with the profit and loss to the paisa');
    assert.equal(net.total.budgetPaise, 2_00_000_00 - 1_20_000_00 - 40_000_00);
    // By quarter: April and May in Q1, against two of the quarter's three months... the whole quarter's budget to 31 May.
    const q = await budgetVsActuals(f.trx, f.orgId, id, { today: '2026-05-31', upto: '2026-05-31', columns: 'quarter' });
    assert.equal(q.columns.length, 1);
    assert.equal(q.sections.flatMap((s) => s.rows).find((x) => x.code === CODE.SALES)!.cells[0].budgetPaise, 2_00_000_00);
    // The full year by month: twelve columns and a total.
    const y = await budgetVsActuals(f.trx, f.orgId, id, { today: '2026-05-31' });
    assert.equal(y.columns.length, 12);
    assert.equal(y.sections.flatMap((s) => s.rows).find((x) => x.code === CODE.SALES)!.total.budgetPaise, 12_00_000_00);
  });
});

test('fill from last year\'s actuals, +/- %: the grid comes from the journal', async () => {
  await withBook(async (f) => {
    await post(f, '2025-04-05', CODE.RENT, 18_000, 0);
    await post(f, '2025-07-05', CODE.RENT, 18_000, 0);
    const r = await actualsForPlan(f.trx, f.orgId, { fyLabel: '2026-27', period: 'quarterly', accountIds: [f.acc[CODE.RENT]], adjustPct: 10 });
    assert.equal(r.sourceFy, '2025-26');
    assert.deepEqual(r.lines[0].amountsPaise, [19_800_00, 19_800_00, 0, 0]);
  });
});

test('costing: a cost centre budget against that cost centre\'s lines only', async () => {
  await withBook(async (f) => {
    const id = await savePlan(f.trx, f.orgId, null, {
      name: 'Chennai showroom', fyLabel: '2026-27', period: 'yearly', costCentreId: f.centre,
      lines: [{ accountId: f.acc[CODE.RENT], amountsPaise: [3_65_000_00] }],
    });
    await post(f, '2026-04-10', CODE.RENT, 40_000, 0, f.centre);
    await post(f, '2026-04-11', CODE.RENT, 99_000, 0); // another centre's rent: not this budget's
    const r = await budgetVsActuals(f.trx, f.orgId, id, { today: '2026-04-30', upto: '2026-04-30' });
    const rent = r.sections.flatMap((s) => s.rows).find((x) => x.code === CODE.RENT)!;
    assert.equal(rent.cells[0].actualPaise, 40_000_00);
    assert.equal(rent.cells[0].budgetPaise, 30_000_00);
    assert.match(r.notes.join(' '), /cost centre only/);
    const cc = await costCentreSummary(f.trx, f.orgId, '2026-27', '2026-04-30');
    const chn = cc.centres.find((c) => c.costCentreId === String(f.centre))!;
    assert.equal(chn.expense.actualPaise, 40_000_00);
    assert.equal(chn.expense.budgetPaise, 30_000_00);
    assert.equal(chn.expense.favourable, false);
    assert.equal(chn.planName, 'Chennai showroom');
  });
});

test('an old yearly budget, moved into a yearly plan, reads month by month exactly as before', async () => {
  await withBook(async (f) => {
    await f.trx.insertInto('budgets').values({ org_id: f.orgId, fy_label: '2026-27', account_id: f.acc[CODE.RENT], branch_id: 0, amount: '365000.0000' }).execute();
    const id = await savePlan(f.trx, f.orgId, null, { name: 'Annual budget', fyLabel: '2026-27', period: 'yearly', lines: [{ accountId: f.acc[CODE.RENT], amountsPaise: [3_65_000_00] }] });
    await post(f, '2026-04-10', CODE.RENT, 30_000, 0);
    const old = await budgetVsActual(f.trx, f.orgId, { fy: '2026-27', asOf: '2026-05-31', today: '2026-05-31' });
    const now = await budgetVsActuals(f.trx, f.orgId, id, { today: '2026-05-31', upto: '2026-05-31', columns: 'month' });
    const rent = now.sections.flatMap((s) => s.rows).find((x) => x.code === CODE.RENT)!;
    const oldRent = old.rows.find((x) => x.code === CODE.RENT)!;
    assert.deepEqual(rent.cells.map((c) => c.budgetPaise), oldRent.months.map((m) => m.budgetPaise));
    assert.deepEqual(rent.cells.map((c) => c.actualPaise), oldRent.months.map((m) => m.actualPaise));
  });
});

test.after(() => db.destroy());
