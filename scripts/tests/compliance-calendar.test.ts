// The compliance calendar: the due dates each kind of book owes, and marking
// them done.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/compliance-calendar.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { complianceCalendar, obligations, type CalendarProfile } from '../../lib/server/tax/compliance-calendar';

const base: CalendarProfile = {
  registration: 'regular', frequency: 'monthly', stateCode: '33', einvoicing: false, deductsTds: false, collectsTcs: false,
  company: false, owesMsmes: false, lutValidTo: null, payroll: false,
};
const due = (p: Partial<CalendarProfile>, key: string, period: string, fy = 2026) =>
  obligations({ ...base, ...p }, fy).find((o) => o.key === key && o.period === period)?.dueDate;
const keys = (p: Partial<CalendarProfile>, fy = 2026) => new Set(obligations({ ...base, ...p }, fy).map((o) => o.key));

test('GST: monthly, quarterly by state, and composition', () => {
  assert.equal(due({}, 'gstr1', '2026-05'), '2026-06-11');
  assert.equal(due({}, 'gstr3b', '2026-12'), '2027-01-20', 'across the calendar year');
  assert.equal(due({}, 'gstr9', '2026'), '2027-12-31');
  assert.equal(due({}, 'gstr9c', '2026'), undefined, 'only above ₹5 crore');
  assert.equal(due({ einvoicing: true }, 'gstr9c', '2026'), '2027-12-31');

  const q = { frequency: 'quarterly' as const };
  assert.equal(due(q, 'gstr1', '2026-Q1'), '2026-07-13');
  assert.equal(due(q, 'gstr3b', '2026-Q1'), '2026-07-22', 'Tamil Nadu files by the 22nd');
  assert.equal(due({ ...q, stateCode: '07' }, 'gstr3b', '2026-Q1'), '2026-07-24', 'Delhi by the 24th');
  assert.equal(due(q, 'gstr3b', '2026-Q4'), '2027-04-22');
  assert.equal(due(q, 'iff', '2026-04'), '2026-05-13');
  assert.equal(due(q, 'pmt06', '2026-05'), '2026-06-25');
  assert.equal(due(q, 'pmt06', '2026-06'), undefined, 'the third month is paid with the return');

  const c = { registration: 'composition' as const };
  assert.equal(due(c, 'cmp08', '2026-Q1'), '2026-07-18');
  assert.equal(due(c, 'gstr4', '2026'), '2027-06-30');
  assert.equal(keys(c).has('gstr1'), false);
  assert.equal(keys({ registration: 'unregistered' }).has('gstr3b'), false);
});

test('TDS and TCS, income tax, and a company’s filings', () => {
  const t = { deductsTds: true };
  assert.equal(due(t, 'tds-deposit', '2026-04'), '2026-05-07');
  assert.equal(due(t, 'tds-deposit', '2027-03'), '2027-04-30', 'March has until 30 April');
  assert.equal(due(t, 'tds-return', '2026-Q4'), '2027-05-31');
  assert.equal(due(t, 'tds-certificates', '2026-Q1'), '2026-08-15');
  assert.equal(due(t, 'tcs-return', '2026-Q1'), undefined, 'only when tax is collected');
  assert.equal(due({ ...t, collectsTcs: true }, 'tcs-return', '2026-Q1'), '2026-07-15');
  assert.equal(keys({}).has('tds-deposit'), false, 'no TAN, no TDS');

  assert.equal(due({}, 'advance-tax', '2026-I4'), '2027-03-15');
  assert.equal(due({}, 'itr', '2026'), '2027-07-31');
  assert.equal(due({ company: true }, 'itr', '2026'), '2027-10-31');
  assert.equal(due({ company: true }, 'aoc4', '2026'), '2027-10-30');
  assert.equal(due({ company: true }, 'msme1', '2026-H2'), undefined, 'only when MSMEs are owed');
  assert.equal(due({ company: true, owesMsmes: true }, 'msme1', '2026-H2'), '2027-04-30');
  assert.equal(due({ lutValidTo: '2027-03-31' }, 'lut', '2027'), '2027-03-31');
  assert.equal(due({}, 'pf', '2026-06'), undefined, 'no employees, no PF');
  assert.equal(due({ payroll: true }, 'pf', '2026-06'), '2026-07-15');
  assert.equal(due({ payroll: true }, 'esi', '2027-03'), '2027-04-15');
  assert.equal(due({ payroll: true }, 'salary-tds-return', '2026-Q2'), '2026-10-31');
  assert.equal(due({ payroll: true }, 'form16', '2026'), '2027-06-15');
});

test('the calendar marks what is done, late, and coming', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Calendar Co', tan: 'CHEA12345B' }).executeTakeFirstOrThrow()).insertId);
      await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).execute();
      await trx.insertInto('compliance_filings').values({ org_id: orgId, item_key: 'gstr1', period: '2026-05', done_on: '2026-06-10', reference: 'AA330626000001X' }).execute();

      const { profile, rows } = await complianceCalendar(trx, orgId, '2026-06-01', '2026-06-30', '2026-06-15');
      assert.equal(profile.deductsTds, true);
      assert.equal(profile.company, false);
      const gstr1 = rows.find((r) => r.key === 'gstr1')!;
      assert.equal(gstr1.status, 'done');
      assert.equal(gstr1.done?.reference, 'AA330626000001X');
      assert.equal(rows.find((r) => r.key === 'tds-deposit')!.status, 'overdue', 'May TDS was due on 7 June');
      assert.equal(rows.find((r) => r.key === 'gstr3b')!.status, 'due_soon');
      const adv = rows.find((r) => r.key === 'advance-tax')!;
      assert.equal(adv.status, 'due_soon', 'due today is not yet late');
      assert.equal(adv.daysLeft, 0);
      assert.deepEqual(rows.map((r) => r.dueDate), [...rows.map((r) => r.dueDate)].sort(), 'in date order');
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test.after(async () => {
  await db.destroy();
});
