// Zoho's recurring invoice profile (services/recurring-profiles.ts, migration
// 123): Repeat Every N, Create Invoices as Drafts, Edit, and the record's
// figures. Against real MySQL inside rolled-back transactions.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/recurring-zoho.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { advancePeriod, runRecurringInvoice } from '../../lib/server/services/recurring';
import { createProfile, profileDetail, updateProfile, type ProfileInput } from '../../lib/server/services/recurring-profiles';
import { repeatChoice, repeatLabel } from '../../lib/recurring-repeat';

interface Fixture { trx: Trx; orgId: number; branchId: number; customerId: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Recurring Zoho Test Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AAACR4849R1ZK' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const customerId = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'customer', display_name: 'Bonita', gst_treatment: 'registered', state_code: '33', pan: 'AAAAA1111A', gstin: '33AAAAA1111A1Z5',
      }).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, customerId });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}
test.after(() => db.destroy());

const profile = (f: Fixture, extra: Partial<ProfileInput> = {}): ProfileInput => ({
  branchId: f.branchId, customerId: f.customerId, name: 'AMC – Bonita', frequency: 'weekly', every: 2, startDate: '2026-11-02',
  paymentTerms: 'net_15', orderNumber: 'PO-9', notes: 'Thank you', terms: 'Net 15',
  lines: [{ itemId: null, description: 'Annual maintenance', qty: 1, ratePaise: 100_000, gstRatePct: 18, hsnSac: '998713' }], ...extra,
});

test('Repeat Every: every N days, weeks, months or years, and the month end stays in its month', () => {
  assert.equal(advancePeriod('2026-11-02', 'weekly', 2), '2026-11-16');
  assert.equal(advancePeriod('2026-11-02', 'daily', 10), '2026-11-12');
  assert.equal(advancePeriod('2026-01-31', 'monthly', 1), '2026-02-28');
  assert.equal(advancePeriod('2026-01-31', 'monthly', 6), '2026-07-31');
  assert.equal(advancePeriod('2026-11-02', 'yearly', 3), '2029-11-02');
  assert.equal(advancePeriod('2026-11-02', 'monthly'), '2026-12-02', 'one period when no count is given');
  assert.equal(repeatLabel('weekly', 2), '2 Weeks');
  assert.equal(repeatLabel('daily', 10), 'Every 10 Days');
  assert.equal(repeatChoice('monthly', 6), '6_months');
  assert.equal(repeatChoice('daily', 3), 'custom');
});

test('a profile repeats every two weeks, carries its fields onto each invoice, and keeps its own order number', async () => {
  await withFixture(async (f) => {
    const id = await createProfile(f.trx, f.orgId, profile(f));
    const r = await runRecurringInvoice(f.trx, f.orgId, null, id);
    const p = await f.trx.selectFrom('recurring_invoices').select(['next_run', 'last_generated_at']).where('id', '=', id).executeTakeFirstOrThrow();
    assert.equal(String(p.next_run).slice(0, 10), '2026-11-16');
    const inv = await f.trx.selectFrom('invoices').select(['status', 'order_number', 'notes', 'terms']).where('id', '=', Number(r.invoice.id)).executeTakeFirstOrThrow();
    assert.equal(inv.status, 'approved');
    assert.equal(inv.order_number, 'PO-9');
    assert.equal(inv.notes, 'Thank you');
    const d = await profileDetail(f.trx, f.orgId, id, '2026-11-03');
    assert.equal(d.repeatLabel, '2 Weeks');
    assert.equal(d.invoices.length, 1);
    assert.equal(d.status, 'active');
    assert.equal(d.remainingCycles, null, 'never expires');
  });
});

test("Create Invoices as Drafts makes each one a draft, and never sends it", async () => {
  await withFixture(async (f) => {
    const id = await createProfile(f.trx, f.orgId, profile(f, { createAsDraft: true, autoSend: true }));
    const r = await runRecurringInvoice(f.trx, f.orgId, null, id);
    assert.equal(r.autoSent, false);
    const inv = await f.trx.selectFrom('invoices').select('status').where('id', '=', Number(r.invoice.id)).executeTakeFirstOrThrow();
    assert.equal(inv.status, 'draft');
  });
});

test('an end date gives the remaining cycles; past it the profile is expired', async () => {
  await withFixture(async (f) => {
    const id = await createProfile(f.trx, f.orgId, profile(f, { frequency: 'monthly', every: 1, startDate: '2026-11-05', endDate: '2027-01-05' }));
    assert.equal((await profileDetail(f.trx, f.orgId, id, '2026-11-01')).remainingCycles, 3);
    for (let i = 0; i < 3; i++) await runRecurringInvoice(f.trx, f.orgId, null, id);
    const d = await profileDetail(f.trx, f.orgId, id, '2027-02-01');
    assert.equal(d.status, 'expired');
    assert.equal(d.remainingCycles, 0);
    assert.equal(d.nextRun, null);
  });
});

test("Edit changes it from the next invoice on; Zoho's messages refuse a bad profile", async () => {
  await withFixture(async (f) => {
    const id = await createProfile(f.trx, f.orgId, profile(f));
    await updateProfile(f.trx, f.orgId, id, profile(f, { startDate: '2026-12-01', every: 1, frequency: 'monthly' }));
    let p = await f.trx.selectFrom('recurring_invoices').select(['next_run', 'repeat_every', 'frequency']).where('id', '=', id).executeTakeFirstOrThrow();
    assert.deepEqual([String(p.next_run).slice(0, 10), p.repeat_every, p.frequency], ['2026-12-01', 1, 'monthly'], 'nothing raised yet: it starts from the new date');
    await runRecurringInvoice(f.trx, f.orgId, null, id);
    await updateProfile(f.trx, f.orgId, id, profile(f, { startDate: '2026-12-01', every: 3, frequency: 'monthly' }));
    p = await f.trx.selectFrom('recurring_invoices').select(['next_run', 'repeat_every', 'frequency']).where('id', '=', id).executeTakeFirstOrThrow();
    assert.equal(String(p.next_run).slice(0, 10), '2027-03-01', 'raised once: the next is three months after it');

    await assert.rejects(createProfile(f.trx, f.orgId, profile(f, { customerId: 0 })), /Select a customer\./);
    await assert.rejects(createProfile(f.trx, f.orgId, profile(f, { name: ' ' })), /Enter the profile name\./);
    await assert.rejects(createProfile(f.trx, f.orgId, profile(f, { lines: [{ itemId: null, description: '', qty: 1, ratePaise: 1, gstRatePct: 18, hsnSac: null }] })), /Enter the valid item name or description\./);
    await assert.rejects(createProfile(f.trx, f.orgId, profile(f, { endDate: '2026-10-01' })), /end date cannot be before/);
  });
});
