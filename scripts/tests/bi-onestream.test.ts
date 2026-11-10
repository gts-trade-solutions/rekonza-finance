// The trial balance in OneStream's import layout: month by month, YTD and
// Periodic, with last year's profit carried into retained earnings.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/bi-onestream.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { postEntry } from '../../lib/server/ledger/posting';
import { member, oneStreamRows } from '../../lib/server/bi/datasets';

async function withBooks(fn: (trx: Trx, orgId: number, acc: Record<string, number>, branchId: number) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Sri Balaji Auto Parts' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'Chennai HO', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      await fn(trx, orgId, await accountIds(trx, orgId), branchId);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const post = (trx: Trx, orgId: number, branchId: number, date: string, lines: [number, number, number][]) =>
  postEntry(trx, { orgId, branchId, date, sourceType: 'manual', userId: null, memo: 'test', lines: lines.map(([accountId, debit, credit]) => ({ accountId, debit, credit })) });

const sum = (rows: Record<string, unknown>[]) => Math.round(rows.reduce((t, r) => t + Number(r.Amount) * 100, 0));
const at = (rows: Record<string, unknown>[], time: string, account: string) => rows.filter((r) => r.Time === time && r.Account === account).reduce((t, r) => t + Number(r.Amount), 0);

test('YTD: closing balances, income and expense from April, last year in retained earnings — and every month nets to nil', async () => {
  await withBooks(async (trx, orgId, acc, branchId) => {
    await post(trx, orgId, branchId, '2026-03-10', [[acc[CODE.AR], 1000_00, 0], [acc[CODE.SALES], 0, 1000_00]]);
    await post(trx, orgId, branchId, '2026-04-05', [[acc[CODE.BANK_DEFAULT], 500_00, 0], [acc[CODE.AR], 0, 500_00]]);
    await post(trx, orgId, branchId, '2026-04-20', [[acc[CODE.RENT], 200_00, 0], [acc[CODE.BANK_DEFAULT], 0, 200_00]]);
    await post(trx, orgId, branchId, '2026-05-15', [[acc[CODE.AR], 300_00, 0], [acc[CODE.SALES], 0, 300_00]]);

    const rows = await oneStreamRows(orgId, { from: '2026-04-01', to: '2026-05-31', view: 'ytd' }, trx);
    assert.deepEqual([...new Set(rows.map((r) => r.Time))], ['2026M4', '2026M5']);
    for (const t of ['2026M4', '2026M5']) assert.equal(sum(rows.filter((r) => r.Time === t)), 0, `${t} nets to nil`);
    assert.equal(at(rows, '2026M4', CODE.AR), 500);
    assert.equal(at(rows, '2026M4', CODE.BANK_DEFAULT), 300);
    assert.equal(at(rows, '2026M4', CODE.RENT), 200, 'expense from 1 April');
    assert.equal(at(rows, '2026M4', CODE.SALES), 0, "last year's sales are not this year's");
    assert.equal(at(rows, '2026M4', CODE.RETAINED), -1000, "last year's profit, in retained earnings");
    assert.equal(at(rows, '2026M5', CODE.SALES), -300);
    const r = rows[0];
    assert.deepEqual([r.Entity, r.Scenario, r.View, r.Flow, r.IC, r.UD1, r.UD2, r.Currency], [member('Sri Balaji Auto Parts'), 'Actual', 'YTD', 'None', 'None', 'Chennai_HO', 'None', 'INR']);
  });
});

test("Periodic: each month's movement only", async () => {
  await withBooks(async (trx, orgId, acc, branchId) => {
    await post(trx, orgId, branchId, '2026-03-10', [[acc[CODE.AR], 1000_00, 0], [acc[CODE.SALES], 0, 1000_00]]);
    await post(trx, orgId, branchId, '2026-04-05', [[acc[CODE.BANK_DEFAULT], 500_00, 0], [acc[CODE.AR], 0, 500_00]]);
    const rows = await oneStreamRows(orgId, { from: '2026-04-01', to: '2026-04-30', view: 'periodic' }, trx);
    assert.equal(rows.length, 2);
    assert.equal(at(rows, '2026M4', CODE.AR), -500);
    assert.equal(at(rows, '2026M4', CODE.BANK_DEFAULT), 500);
    assert.equal(rows[0].View, 'Periodic');
    assert.equal(sum(rows), 0);
  });
});

test.after(async () => {
  await db.destroy();
});
