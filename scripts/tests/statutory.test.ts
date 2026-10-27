// Statutory settings that change with the business: when an invoice needs an
// IRN, a dated change of GST registration, and a branch's own e-way threshold.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/statutory.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { changeRegistration, irnRequired, registrationOn, setEinvoicing } from '../../lib/server/services/statutory';
import { assessEwayBill } from '../../lib/tax/eway';

interface Fixture { trx: Trx; orgId: number; branchId: number; b2b: number; sez: number; consumer: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Statutory Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({
        org_id: orgId, name: 'HQ', state_code: '33', gstin: '33AAACS1234A1Z5', is_primary: 1,
      }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '998714', kind: 'sac', description: 'Repairs', gst_rate_pct: 18, is_active: 1 }).execute();
      const mk = async (values: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', state_code: '33', ...values } as never).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId,
        b2b: await mk({ display_name: 'Registered Buyer', gst_treatment: 'registered', gstin: '33AAACB5678B1Z2' }),
        sez: await mk({ display_name: 'SEZ Unit', gst_treatment: 'sez', gstin: '33AAACZ9999C1Z1' }),
        consumer: await mk({ display_name: 'Walk-in', gst_treatment: 'consumer' }),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const sell = (f: Fixture, customerId: number, date: string) => createInvoice(f.trx, f.orgId, null, {
  branchId: f.branchId, customerId, date, dueDate: date, status: 'approved',
  lines: [{ description: 'Repair', hsnSac: '998714', qty: 1, ratePaise: 10_000_00, gstRatePct: 18 }],
});
const irnStatus = async (f: Fixture, invoiceId: number) =>
  (await f.trx.selectFrom('einvoices').select('status').where('invoice_id', '=', invoiceId).executeTakeFirstOrThrow()).status;

test('who needs an IRN', () => {
  const on = { applicable: true, from: '2025-04-01' };
  assert.equal(irnRequired(on, '33AAACS1234A1Z5', 'registered', '2025-06-01'), true);
  assert.equal(irnRequired(on, '33AAACS1234A1Z5', 'sez', '2025-06-01'), true, 'SEZ supplies too');
  assert.equal(irnRequired(on, '33AAACS1234A1Z5', 'overseas', '2025-06-01'), true, 'and exports');
  assert.equal(irnRequired(on, '33AAACS1234A1Z5', 'consumer', '2025-06-01'), false, 'not B2C');
  assert.equal(irnRequired(on, '33AAACS1234A1Z5', 'registered', '2025-03-31'), false, 'not before it applies');
  assert.equal(irnRequired(on, null, 'registered', '2025-06-01'), false, 'not from an unregistered branch');
  assert.equal(irnRequired({ applicable: false, from: null }, '33AAACS1234A1Z5', 'registered', '2025-06-01'), false);
});

test('e-invoicing switched on and off brings the IRN queue with it', async () => {
  await withFixture(async (f) => {
    const before = await sell(f, f.b2b, '2026-03-20');
    const after = await sell(f, f.b2b, '2026-04-10');
    const sez = await sell(f, f.sez, '2026-04-11');
    const b2c = await sell(f, f.consumer, '2026-04-12');
    for (const i of [before, after, sez, b2c]) assert.equal(await irnStatus(f, i.id), 'not_applicable', 'off by default');

    await assert.rejects(setEinvoicing(f.trx, f.orgId, { applicable: true, from: '2026-04-10' }), /1 April/);
    assert.deepEqual(await setEinvoicing(f.trx, f.orgId, { applicable: true, from: '2026-04-01' }), { queued: 2, cleared: 0 });
    assert.equal(await irnStatus(f, before.id), 'not_applicable', 'issued before it applied');
    assert.equal(await irnStatus(f, after.id), 'pending');
    assert.equal(await irnStatus(f, sez.id), 'pending');
    assert.equal(await irnStatus(f, b2c.id), 'not_applicable');

    const next = await sell(f, f.b2b, '2026-05-01');
    assert.equal(await irnStatus(f, next.id), 'pending', 'new invoices are queued as they are issued');

    assert.deepEqual(await setEinvoicing(f.trx, f.orgId, { applicable: false, from: null }), { queued: 0, cleared: 3 });
    assert.equal(await irnStatus(f, after.id), 'not_applicable');
  });
});

test('a change of registration takes effect on its date, and old documents keep theirs', async () => {
  await withFixture(async (f) => {
    await f.trx.updateTable('organizations').set({ gst_registration_type: 'composition' }).where('id', '=', f.orgId).execute();
    await sell(f, f.consumer, '2026-03-15');
    const change = (effectiveFrom: string, reason = 'Opted out of composition (CMP-04 filed)') =>
      changeRegistration(f.trx, f.orgId, null, { toType: 'regular', effectiveFrom, reason });

    await assert.rejects(change('2026-03-01'), /was issued as composition/);
    await assert.rejects(change('2026-04-01', 'no'), /Give the reason/);
    await assert.rejects(change('2999-04-01'), /not before/);
    const history = await change('2026-04-01');
    assert.equal(history.length, 1);
    assert.equal(history[0].fromType, 'composition');

    assert.equal(await registrationOn(f.trx, f.orgId, '2026-03-31'), 'composition');
    assert.equal(await registrationOn(f.trx, f.orgId, '2026-04-01'), 'regular');
    await assert.rejects(
      changeRegistration(f.trx, f.orgId, null, { toType: 'composition', effectiveFrom: '2026-03-20', reason: 'Back again' }),
      /has to come after it/,
    );
  });
});

test('a branch’s own intra-state threshold, never below ₹50,000, and never for inter-state', () => {
  const base = { supplyKind: 'goods' as const, fromStateCode: '33', toStateCode: '33', reason: 'supply' as const, docDate: '2026-06-01', today: '2026-06-01' };
  assert.equal(assessEwayBill({ ...base, consignmentPaise: 90_000_00 }).required, false, 'Tamil Nadu: ₹1 lakh built in');
  assert.equal(assessEwayBill({ ...base, consignmentPaise: 90_000_00, intraThresholdPaise: 75_000_00 }).required, true, 'the branch’s own lower figure');
  assert.equal(assessEwayBill({ ...base, consignmentPaise: 45_000_00, intraThresholdPaise: 10_000_00 }).required, false, 'the floor still holds');
  assert.equal(assessEwayBill({ ...base, toStateCode: '29', consignmentPaise: 60_000_00, intraThresholdPaise: 2_00_000_00 }).required, true, 'inter-state is always ₹50,000');
});

test.after(async () => {
  await db.destroy();
});
