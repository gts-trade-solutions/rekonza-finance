// Custom report filters (status review 7, item 13): Zoho's Customize Report
// over the profit and loss, balance sheet, trial balance, general ledger,
// account transactions and cash flow. Each filter — customer, vendor, cost
// centre, project, reporting tag, branch, accounts — changes the figures
// through the journal lines' own contact, cost centre, project and tag; the
// heading states every filter; a filtered balance sheet says it cannot
// balance; month columns and comparisons add up.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/sr7-custom-report-filters.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { postEntry } from '../../lib/server/ledger/posting';
import { createInvoice, voidInvoice } from '../../lib/server/services/sales';
import { setTags } from '../../lib/server/services/reporting-tags';
import { customReport, columnsFor, type CustomSpec } from '../../lib/server/reports/custom-report';
import { profitAndLoss } from '../../lib/server/reports/statements';

interface F {
  trx: Trx; orgId: number; hq: number; west: number; acc: Record<string, number>;
  a: number; b: number; cc: number; project: number; south: number; north: number; tag: number;
  inv1: number; inv2: number;
}

async function withBook(fn: (f: F) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Filter Co' }).executeTakeFirstOrThrow()).insertId);
      const branch = async (name: string, primary: number) => Number((await trx.insertInto('branches').values({ org_id: orgId, name, state_code: '33', is_primary: primary }).executeTakeFirstOrThrow()).insertId);
      const hq = await branch('Chennai', 1);
      const west = await branch('Mumbai', 0);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'HDFC', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0', is_active: 1 } as never).execute();
      const contact = async (name: string) => Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', display_name: name, state_code: '33', gst_treatment: 'unregistered' } as never).executeTakeFirstOrThrow()).insertId);
      const a = await contact('Apex Motors');
      const b = await contact('Bharat Garage');
      const cc = Number((await trx.insertInto('cost_centres').values({ org_id: orgId, code: 'SHW', name: 'Showroom' }).executeTakeFirstOrThrow()).insertId);
      const project = Number((await trx.insertInto('projects').values({ org_id: orgId, customer_id: a, name: 'Fleet service contract' }).executeTakeFirstOrThrow()).insertId);
      const tag = Number((await trx.insertInto('reporting_tags').values({ org_id: orgId, name: 'Region' }).executeTakeFirstOrThrow()).insertId);
      const opt = async (v: string) => Number((await trx.insertInto('reporting_tag_options').values({ org_id: orgId, tag_id: tag, value: v }).executeTakeFirstOrThrow()).insertId);
      const south = await opt('South');
      const north = await opt('North');
      // Invoice 1: Apex, ₹10,000, the showroom's, the fleet project, tagged South, in April.
      const i1 = await createInvoice(trx, orgId, null, { branchId: hq, customerId: a, date: '2026-04-10', dueDate: '2026-05-10', status: 'approved', costCentreId: cc, lines: [{ description: 'Service', qty: 1, ratePaise: 10_000_00, gstRatePct: 0 }] });
      await trx.updateTable('invoices').set({ project_id: project }).where('id', '=', i1.id).execute();
      await setTags(trx, orgId, 'invoice', i1.id, { [String(tag)]: String(south) });
      // Invoice 2: Bharat, ₹5,000, Mumbai branch, tagged North, in May.
      const i2 = await createInvoice(trx, orgId, null, { branchId: west, customerId: b, date: '2026-05-12', dueDate: '2026-06-12', status: 'approved', lines: [{ description: 'Parts', qty: 1, ratePaise: 5_000_00, gstRatePct: 0 }] });
      await setTags(trx, orgId, 'invoice', i2.id, { [String(tag)]: String(north) });
      // Showroom rent ₹2,000 in May.
      await postEntry(trx, { orgId, branchId: hq, date: '2026-05-01', sourceType: 'manual', module: 'accountant', memo: 'Rent', lines: [
        { accountId: acc[CODE.RENT], debit: 2_000_00, costCentreId: cc }, { accountId: acc[CODE.BANK_DEFAULT], credit: 2_000_00 },
      ] });
      await fn({ trx, orgId, hq, west, acc, a, b, cc, project, south, north, tag, inv1: i1.id, inv2: i2.id });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const pl = (f: F, filter: CustomSpec['filter'] = {}, extra: Partial<CustomSpec> = {}) =>
  customReport(f.trx, f.orgId, { report: 'profit-and-loss', from: '2026-04-01', to: '2026-05-31', filter, ...extra });
const sales = (r: Awaited<ReturnType<typeof customReport>>, i = 0) => r.sections.flatMap((s) => s.rows).find((x) => x.code === CODE.SALES)?.values[i] ?? 0;
const rent = (r: Awaited<ReturnType<typeof customReport>>, i = 0) => r.sections.flatMap((s) => s.rows).find((x) => x.code === CODE.RENT)?.values[i] ?? 0;
const net = (r: Awaited<ReturnType<typeof customReport>>, i = 0) => r.results.find((x) => x.key === 'net')!.values[i];

test('each filter changes the P&L through the lines\' own contact, cost centre, project, tag and branch', async () => {
  await withBook(async (f) => {
    const all = await pl(f);
    assert.equal(sales(all), 15_000_00);
    assert.equal(net(all), 13_000_00);
    const plain = await profitAndLoss(f.trx, f.orgId, '2026-04-01', '2026-05-31');
    assert.equal(net(all), plain.netProfit, 'unfiltered, it is the plain profit and loss');
    // Customer: only Apex's invoice.
    const apex = await pl(f, { contactIds: [f.a] });
    assert.equal(sales(apex), 10_000_00);
    assert.equal(rent(apex), 0);
    assert.ok(apex.applied.includes('Customer / vendor: Apex Motors'), apex.applied.join(' | '));
    // Cost centre: the showroom's sales and rent.
    const shw = await pl(f, { costCentreIds: [f.cc] });
    assert.deepEqual([sales(shw), rent(shw), net(shw)], [10_000_00, 2_000_00, 8_000_00]);
    assert.ok(shw.applied.includes('Cost centre: Showroom'));
    // Project, by the invoice's project.
    const proj = await pl(f, { projectIds: [f.project] });
    assert.equal(sales(proj), 10_000_00);
    assert.ok(proj.applied.includes('Project: Fleet service contract'));
    // Reporting tag, by the invoice's tag.
    assert.equal(sales(await pl(f, { tagOptionIds: [f.south] })), 10_000_00);
    const north = await pl(f, { tagOptionIds: [f.north] });
    assert.equal(sales(north), 5_000_00);
    assert.ok(north.applied.includes('Reporting tag: Region = North'));
    // Branch.
    assert.equal(sales(await pl(f, { branchId: f.west })), 5_000_00);
    // Chosen accounts and account types.
    const onlyRent = await pl(f, { accountIds: [f.acc[CODE.RENT]] });
    assert.deepEqual(onlyRent.sections.flatMap((s) => s.rows).map((r) => r.code), [CODE.RENT]);
    const onlyIncome = await pl(f, { accountTypes: ['income'] });
    assert.ok(onlyIncome.sections.flatMap((s) => s.rows).every((r) => r.code.startsWith('4')));
    // A voided invoice nets to nil under its project: the reversal keeps the document.
    await voidInvoice(f.trx, f.orgId, null, f.inv1, 'Raised in error');
    assert.equal(sales(await pl(f, { projectIds: [f.project] })), 0);
    assert.equal(sales(await pl(f, { tagOptionIds: [f.south] })), 0);
  });
});

test('report by month and compare with the previous year give one column each', async () => {
  await withBook(async (f) => {
    const m = await pl(f, {}, { reportBy: 'month' });
    assert.deepEqual(m.columns.map((c) => c.label), ['Apr 2026', 'May 2026']);
    assert.deepEqual([sales(m, 0), sales(m, 1)], [10_000_00, 5_000_00]);
    assert.deepEqual([net(m, 0), net(m, 1)], [10_000_00, 3_000_00]);
    const cmp = await pl(f, {}, { compareMode: 'previous_year', compareCount: 1 });
    assert.equal(cmp.columns.length, 2);
    assert.deepEqual([cmp.columns[1].from, cmp.columns[1].to], ['2025-04-01', '2025-05-31']);
    assert.equal(sales(cmp, 1), 0);
    // Previous periods of a whole month go back month by month; quarters are Indian quarters.
    assert.deepEqual(columnsFor({ report: 'profit-and-loss', from: '2026-05-01', to: '2026-05-31', compareMode: 'previous_period', compareCount: 2 }).map((c) => c.from), ['2026-05-01', '2026-04-01', '2026-03-01']);
    assert.deepEqual(columnsFor({ report: 'profit-and-loss', from: '2026-04-01', to: '2027-03-31', reportBy: 'quarter' }).map((c) => c.to), ['2026-06-30', '2026-09-30', '2026-12-31', '2027-03-31']);
  });
});

test('a balance sheet or trial balance cut by a filter says it cannot balance; unfiltered it balances', async () => {
  await withBook(async (f) => {
    const bs = await customReport(f.trx, f.orgId, { report: 'balance-sheet', from: '2026-04-01', to: '2026-05-31' });
    assert.deepEqual(bs.balanced, [true]);
    assert.equal(bs.cannotBalance, false);
    const cut = await customReport(f.trx, f.orgId, { report: 'balance-sheet', from: '2026-04-01', to: '2026-05-31', filter: { contactIds: [f.a] } });
    assert.equal(cut.cannotBalance, true);
    assert.match(cut.notes.join(' '), /does not balance and is not meant to/);
    const ar = cut.sections.flatMap((s) => s.rows).find((r) => r.code === CODE.AR)!;
    assert.equal(ar.values[0], 10_000_00, 'Apex owes ₹10,000');
    const tb = await customReport(f.trx, f.orgId, { report: 'trial-balance', from: '2026-04-01', to: '2026-05-31', filter: { costCentreIds: [f.cc] } });
    assert.equal(tb.cannotBalance, true);
    const tbAll = await customReport(f.trx, f.orgId, { report: 'trial-balance', from: '2026-04-01', to: '2026-05-31', accounts: 'all' });
    assert.deepEqual(tbAll.balanced, [true]);
    assert.ok(tbAll.sections[0].rows.some((r) => r.values[0] === 0), '"all accounts" includes those with no balance');
  });
});

test('general ledger and account transactions keep only the lines the filters keep; cash flow by branch', async () => {
  await withBook(async (f) => {
    const gl = await customReport(f.trx, f.orgId, { report: 'general-ledger', from: '2026-04-01', to: '2026-05-31', accountId: String(f.acc[CODE.AR]), filter: { contactIds: [f.b] } });
    assert.equal(gl.lines!.length, 1);
    assert.equal(gl.lines![0].debitPaise, 5_000_00);
    assert.equal(gl.closing, 5_000_00);
    const at = await customReport(f.trx, f.orgId, { report: 'account-transactions', from: '2026-04-01', to: '2026-05-31', filter: { contactIds: [f.b] } });
    assert.ok(at.lines!.length >= 2);
    assert.ok(at.lines!.every((l) => l.entryId === at.lines![0].entryId), 'only invoice 2\'s lines');
    const atRent = await customReport(f.trx, f.orgId, { report: 'account-transactions', from: '2026-04-01', to: '2026-05-31', filter: { accountIds: [f.acc[CODE.RENT]] } });
    assert.deepEqual(atRent.lines!.map((l) => l.debitPaise), [2_000_00]);
    const cf = await customReport(f.trx, f.orgId, { report: 'cash-flow', from: '2026-04-01', to: '2026-05-31', filter: { branchId: f.hq } });
    assert.equal(cf.results.find((r) => r.key === 'net')!.values[0], -2_000_00, 'Chennai paid the rent');
  });
});

test.after(() => db.destroy());
