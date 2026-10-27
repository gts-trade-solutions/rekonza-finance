// Paying micro and small suppliers: each supplier's own deadline, who is
// covered, the year-end disallowance, and MSME-1.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/msme.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createBill } from '../../lib/server/services/purchases';
import { makePayment } from '../../lib/server/services/payments';
import { msme1, msmeCovered, msmeDeadline, msmeDisallowance, msmeInterest, msmeInterestReport, msmeOpenBills } from '../../lib/server/services/msme';

interface Fixture { trx: Trx; orgId: number; branchId: number; bankId: number; vendor: (v: Record<string, unknown>) => Promise<number> }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'MSME Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
      }).executeTakeFirstOrThrow()).insertId);
      const vendor = async (v: Record<string, unknown>) => Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'vendor', state_code: '33', gst_treatment: 'unregistered', is_msme: 1, ...v,
      } as never).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, bankId, vendor });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const bill = (f: Fixture, vendorId: number, no: string, date: string, ratePaise: number) => createBill(f.trx, f.orgId, null, {
  branchId: f.branchId, vendorId, vendorInvoiceNo: no, date, dueDate: date,
  lines: [{ description: 'Job work', qty: 1, ratePaise, gstRatePct: 18 }],
});
const pay = (f: Fixture, vendorId: number, billId: number, date: string, amountPaise: number) => makePayment(f.trx, f.orgId, null, {
  branchId: f.branchId, contactId: vendorId, date, mode: 'neft', amountPaise, bankAccountId: f.bankId,
  allocations: [{ targetType: 'bill', targetId: billId, amountPaise }],
});

test('the rules themselves', () => {
  assert.equal(msmeDeadline('2026-03-01', null), '2026-03-16', '15 days without a written agreement');
  assert.equal(msmeDeadline('2026-03-01', 30), '2026-03-31');
  assert.equal(msmeDeadline('2026-03-01', 90), '2026-04-15', 'never more than 45');
  assert.equal(msmeCovered('micro', 'manufacturing'), true);
  assert.equal(msmeCovered('medium', 'services'), false);
  assert.equal(msmeCovered('small', 'trading'), false, 'Udyam for traders is for lending only');
  assert.equal(msmeCovered(null, null), true, 'unknown is treated as covered');
});

test('open bills run against each supplier’s own deadline; medium and traders drop out', async () => {
  await withFixture(async (f) => {
    const noDeal = await f.vendor({ display_name: 'No Agreement Works', msme_category: 'micro' });
    const deal = await f.vendor({ display_name: 'Agreed 45', msme_category: 'small', msme_agreement_days: 45 });
    const medium = await f.vendor({ display_name: 'Medium Ltd', msme_category: 'medium' });
    const trader = await f.vendor({ display_name: 'Trader', msme_category: 'micro', msme_activity: 'trading' });
    for (const v of [noDeal, deal, medium, trader]) await bill(f, v, `B-${v}`, '2026-06-01', 10_000_00);

    const open = await msmeOpenBills(f.trx, f.orgId, '2026-06-20');
    assert.deepEqual(open.map((b) => b.vendorName).sort(), ['Agreed 45', 'No Agreement Works']);
    const a = open.find((b) => b.vendorName === 'No Agreement Works')!;
    assert.equal(a.deadline, '2026-06-16');
    assert.equal(a.risk, 'breached', 'four days past 15');
    const b = open.find((x) => x.vendorName === 'Agreed 45')!;
    assert.equal(b.risk, 'safe');
    assert.equal(b.daysLeft, 26);
  });
});

test('the year-end disallowance: owed on 31 March and not paid by the deadline, on the expense only', async () => {
  await withFixture(async (f) => {
    const v = await f.vendor({ display_name: 'Fabricator', msme_category: 'micro', msme_agreement_days: 30 });
    // Paid late but inside the year: deductible this year, nothing disallowed.
    const early = await bill(f, v, 'E-1', '2026-06-01', 10_000_00);
    await pay(f, v, early.id, '2026-09-01', 11_800_00);
    // Billed 10 March, deadline 9 April, paid 5 April: allowed this year.
    const ontime = await bill(f, v, 'M-1', '2027-03-10', 20_000_00);
    await pay(f, v, ontime.id, '2027-04-05', 23_600_00);
    // Billed 1 February, deadline 3 March, unpaid at year end, paid in June.
    const late = await bill(f, v, 'F-1', '2027-02-01', 50_000_00);
    await pay(f, v, late.id, '2027-06-15', 59_000_00);

    const d = await msmeDisallowance(f.trx, f.orgId, 2026, '2027-07-01');
    assert.equal(d.rows.length, 2);
    const m = d.rows.find((r) => r.internalNo.length && r.date === '2027-03-10')!;
    assert.equal(m.paidInTimePaise, 23_600_00);
    assert.equal(m.disallowedPaise, 0);
    const fRow = d.rows.find((r) => r.date === '2027-02-01')!;
    assert.equal(fRow.owedAtYearEndPaise, 59_000_00);
    assert.equal(fRow.disallowedPaise, 50_000_00, 'the expense, not the GST');
    assert.equal(d.totalDisallowedPaise, 50_000_00);
    assert.equal(d.provisional, false);

    // The next year takes it back, as it was paid then.
    const next = await msmeDisallowance(f.trx, f.orgId, 2027, '2027-07-01');
    assert.equal(next.totalAllowedThisYearPaise, 50_000_00);
  });
});

test('MSME-1 lists dues more than 45 days old at the half-year end', async () => {
  await withFixture(async (f) => {
    const v = await f.vendor({ display_name: 'Caster', msme_category: 'small', pan: 'AAAPC1234D' });
    await bill(f, v, 'C-1', '2026-07-01', 30_000_00); // 91 days at 30 September
    await bill(f, v, 'C-2', '2026-09-01', 10_000_00); // 29 days: not yet
    const r = await msme1(f.trx, f.orgId, '2026-09-30');
    assert.equal(r.dueBy, '2026-10-31');
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].bills.length, 1);
    assert.equal(r.rows[0].amountDuePaise, 35_400_00);
    assert.equal(r.rows[0].bills[0].dueFrom, '2026-07-16');
  });
});

test('interest under s.16: three times the bank rate, compounded monthly, from the day after the deadline', async () => {
  // 3 × 6.5% = 19.5% a year, 1.625% a month.
  assert.equal(msmeInterest(1_00_000_00, '2026-04-16', '2026-05-15', 6.5), 1_625_00, 'one month');
  assert.equal(msmeInterest(1_00_000_00, '2026-01-01', '2026-03-31', 6.5), Math.round(1_00_000_00 * 1.01625 ** 2 * (1 + 0.01625 * 31 / 30) - 1_00_000_00), 'two months compounded and the rest simple');
  assert.equal(msmeInterest(1_00_000_00, '2026-05-01', '2026-04-30', 6.5), 0, 'paid in time');
  await withFixture(async (f) => {
    const v = await f.vendor({ display_name: 'Late Paid', msme_category: 'micro' });
    const b = await bill(f, v, 'LP-1', '2026-03-01', 10_000_00);
    await pay(f, v, b.id, '2026-04-16', 11_800_00);
    await bill(f, v, 'LP-2', '2026-06-01', 10_000_00);
    const r = await msmeInterestReport(f.trx, f.orgId, 2026, '2026-07-16', 5.5);
    const paidRow = r.rows.find((x) => x.date === '2026-03-01')!;
    assert.equal(paidRow.paidLatePaise, 11_800_00);
    assert.equal(paidRow.interestOnPaidPaise, msmeInterest(11_800_00, '2026-03-17', '2026-04-16', 5.5));
    assert.equal(paidRow.interestOnPaidPaise, 16_766);
    const unpaid = r.rows.find((x) => x.date === '2026-06-01')!;
    assert.equal(unpaid.unpaidLatePaise, 11_800_00);
    assert.equal(r.disclosure.principalUnpaidPaise, 11_800_00);
    assert.equal(r.disclosure.interestAccruedUnpaidPaise, paidRow.interestOnPaidPaise + unpaid.interestOnUnpaidPaise);
  });
});

test.after(async () => {
  await db.destroy();
});
