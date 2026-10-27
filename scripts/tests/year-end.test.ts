// Closing a financial year: checks, locks, the record kept, reopening, and the
// year's statements as a workbook.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/year-end.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import readXlsxFile from 'read-excel-file/node';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { postEntry } from '../../lib/server/ledger/posting';
import { setBooksStartDate } from '../../lib/server/services/opening-balances';
import { createInvoice } from '../../lib/server/services/sales';
import { closeYear, listYears, reopenYear, yearPack } from '../../lib/server/services/year-end';
import { workbook } from '../../lib/xlsx';

interface Fixture { trx: Trx; orgId: number; branchId: number; acc: Record<string, number>; customer: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Year End Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const customer = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'customer', display_name: 'Buyer', state_code: '33', gst_treatment: 'unregistered',
      } as never).executeTakeFirstOrThrow()).insertId);
      await setBooksStartDate(trx, orgId, '2025-04-01');
      await fn({ trx, orgId, branchId, acc, customer });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const TODAY = '2026-10-26';

test('years are closed in order, lock every module, and keep the year as it stood', async () => {
  await withFixture(async (f) => {
    await createInvoice(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customer, date: '2025-11-01', dueDate: '2025-12-01', status: 'approved',
      lines: [{ description: 'Service', qty: 1, ratePaise: 1_00_000_00, gstRatePct: 0 }],
    });
    let years = await listYears(f.trx, f.orgId, TODAY);
    assert.deepEqual(years.map((y) => [y.label, y.status, y.canClose]), [['2026-27', 'current', false], ['2025-26', 'open', true]]);

    await assert.rejects(closeYear(f.trx, f.orgId, null, 2026, { today: TODAY }), /has not ended yet/);
    const r = await closeYear(f.trx, f.orgId, null, 2025, { today: TODAY });
    assert.equal(r.netProfitPaise, 1_00_000_00);

    const locks = await f.trx.selectFrom('transaction_locks').select(['module', 'locked_upto']).where('org_id', '=', f.orgId).execute();
    assert.equal(locks.length, 4);
    assert.ok(locks.every((l) => String(l.locked_upto).slice(0, 10) === '2026-03-31'));
    await assert.rejects(
      postEntry(f.trx, {
        orgId: f.orgId, branchId: f.branchId, date: '2026-03-15', sourceType: 'manual', module: 'accountant',
        lines: [{ accountId: f.acc[CODE.CASH], debit: 100 }, { accountId: f.acc[CODE.SALES], credit: 100 }],
      }),
      /locked up to 2026-03-31/,
    );

    years = await listYears(f.trx, f.orgId, TODAY);
    const closed = years.find((y) => y.fyStart === 2025)!;
    assert.equal(closed.status, 'closed');
    assert.equal(closed.canReopen, true);
    const snap = await f.trx.selectFrom('financial_years').select('snapshot').where('org_id', '=', f.orgId).executeTakeFirstOrThrow();
    const s = typeof snap.snapshot === 'string' ? JSON.parse(snap.snapshot) : snap.snapshot;
    assert.equal(s.totalDebit, s.totalCredit);

    await assert.rejects(reopenYear(f.trx, f.orgId, null, 2025, 'x'), /Say why/);
    await reopenYear(f.trx, f.orgId, null, 2025, 'Audit adjustment to depreciation');
    const after = await f.trx.selectFrom('transaction_locks').select('locked_upto').where('org_id', '=', f.orgId).execute();
    assert.ok(after.every((l) => l.locked_upto === null), 'back to no lock: there is no earlier closed year');
  });
});

test('a later lock is never moved back by closing an earlier year', async () => {
  await withFixture(async (f) => {
    await f.trx.insertInto('transaction_locks').values({ org_id: f.orgId, module: 'sales', locked_upto: '2026-06-30', reason: 'Q1 filed' }).execute();
    await closeYear(f.trx, f.orgId, null, 2025, { today: TODAY });
    const sales = await f.trx.selectFrom('transaction_locks').select('locked_upto').where('org_id', '=', f.orgId).where('module', '=', 'sales').executeTakeFirstOrThrow();
    assert.equal(String(sales.locked_upto).slice(0, 10), '2026-06-30');
  });
});

test('the year pack is a workbook with the statements and every entry', async () => {
  await withFixture(async (f) => {
    await createInvoice(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customer, date: '2025-11-01', dueDate: '2025-12-01', status: 'approved',
      lines: [{ description: 'Service', qty: 1, ratePaise: 50_000_00, gstRatePct: 0 }],
    });
    const { filename, sheets } = await yearPack(f.trx, f.orgId, 2025);
    assert.match(filename, /FY2025-26\.xlsx$/);
    const read = (await readXlsxFile(Buffer.from(workbook(sheets)))) as unknown as { sheet: string; data: unknown[][] }[];
    assert.deepEqual(read.map((x) => x.sheet), ['Trial Balance', 'Profit and Loss', 'Balance Sheet', 'Day Book']);
    const pl = read[1].data;
    assert.equal(pl.find((r) => r[2] === 'Net profit')![3], 50000);
    assert.ok(read[3].data.length >= 3, 'header and the invoice’s lines');
  });
});

test.after(async () => {
  await db.destroy();
});
