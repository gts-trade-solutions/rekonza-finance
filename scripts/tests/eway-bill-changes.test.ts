// Changing an e-way bill after it is generated, against real MySQL, inside
// rolled-back transactions.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/eway-bill-changes.test.ts
//
// Three things can happen to a bill on the road — a new vehicle, more time, or
// cancellation — and each has a legal limit. These pin the limits, that the
// portal is not asked when a limit says no, and what the register keeps.
//
// The portal call is passed in: the real one writes its log through a separate
// connection, which would wait on this test's uncommitted organisation row.

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { ApiError } from '../../lib/server/http';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import {
  cancelEwayBill, changeEwayVehicle, extendEwayBill, generateEwayBill,
} from '../../lib/server/integrations/gst/eway-service';
import { cancelEinvoice } from '../../lib/server/integrations/gst/einvoice-service';
import type { PortalCaller } from '../../lib/server/integrations/gst/index';
import { ewbCancelDeadline } from '../../lib/tax/eway';

const HOUR = 3_600_000;

interface Fixture {
  trx: Trx;
  orgId: number;
  invoiceId: number;
  billId: number;
  ewbNo: string;
}

/** Stands in for the logged portal call: runs it, and counts the asks. */
function portal() {
  const asked: string[] = [];
  const call = (async (record: { operation: string }, payload: unknown, fn: () => Promise<unknown>) => {
    void payload;
    asked.push(record.operation);
    return fn();
  }) as unknown as PortalCaller;
  return { asked, call };
}

const refusedWith = (code: string) => (err: unknown) => err instanceof ApiError && err.code === code;
const badRequest = (err: unknown) => err instanceof ApiError && err.status === 400;

/** An issued invoice with a stand-in e-way bill on it: TN01AB1234, 250 km. */
async function withBill(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const org = await trx.insertInto('organizations')
        .values({ name: 'E-way Bill Test Co', aato_above_5cr: 1 })
        .executeTakeFirstOrThrow();
      const orgId = Number(org.insertId);

      const branch = await trx.insertInto('branches')
        .values({
          org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1,
          gstin: '33AABCU9603R1ZU', address: '14 Anna Salai', city: 'Chennai', pincode: '600002',
        })
        .executeTakeFirstOrThrow();

      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);

      const customer = await trx.insertInto('contacts')
        .values({
          org_id: orgId, kind: 'customer', display_name: 'Ridge Office', gst_treatment: 'registered',
          state_code: '33', gstin: '33AAACR5055K1ZE', billing_address: '9 Mount Road',
          billing_city: 'Chennai', billing_pincode: '600006',
        })
        .executeTakeFirstOrThrow();

      const item = await trx.insertInto('items')
        .values({
          org_id: orgId, kind: 'goods', name: 'Widget', sku: 'W-1', hsn_sac: '8708',
          uqc: 'NOS', sale_price: '1000.0000', purchase_price: '600.0000',
          gst_rate_pct: 18, sale_account_id: acc[CODE.SALES],
        })
        .executeTakeFirstOrThrow();

      await trx.insertInto('hsn_codes').values({
        org_id: orgId, code: '8708', kind: 'hsn', description: 'Motor vehicle parts',
        gst_rate_pct: 18, is_active: 1,
      }).execute();

      const inv = await createInvoice(trx, orgId, null, {
        branchId: Number(branch.insertId), customerId: Number(customer.insertId),
        date: new Date().toISOString().slice(0, 10), dueDate: '2099-12-31',
        status: 'approved', lines: [{ itemId: Number(item.insertId), qty: 2 }],
      });

      const gen = await generateEwayBill(
        trx, orgId, { kind: 'invoice', id: inv.id },
        { vehicleNo: 'TN01AB1234', distanceKm: 250 },
        { call: portal().call },
      );
      const bill = await trx.selectFrom('eway_bills').select('id')
        .where('invoice_id', '=', inv.id).executeTakeFirstOrThrow();

      await fn({ trx, orgId, invoiceId: inv.id, billId: bill.id, ewbNo: gen.ewayBillNo });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const events = (trx: Trx, billId: number) =>
  trx.selectFrom('eway_bill_events')
    .select(['kind', 'eway_bill_no', 'vehicle_no', 'from_place', 'reason_code'])
    .where('eway_bill_id', '=', billId)
    .orderBy('id')
    .execute();

const extension = {
  remainingDistanceKm: 150,
  fromPlace: 'Hosur',
  fromPincode: '635109',
  reason: '4' as const,
  consignment: 'in_movement' as const,
};

// ── The history ──────────────────────────────────────────────────────────────

test('generating a bill writes the first line of its history', async () => {
  await withBill(async ({ trx, billId, ewbNo }) => {
    assert.deepEqual(await events(trx, billId), [
      { kind: 'generated', eway_bill_no: ewbNo, vehicle_no: 'TN01AB1234', from_place: null, reason_code: null },
    ]);
  });
});

// ── A new vehicle ────────────────────────────────────────────────────────────

test('a new vehicle is recorded with where it happened, and the expiry stays put', async () => {
  await withBill(async ({ trx, orgId, billId }) => {
    const before = await trx.selectFrom('eway_bills').select('valid_until')
      .where('id', '=', billId).executeTakeFirstOrThrow();
    const p = portal();
    const out = await changeEwayVehicle(
      trx, orgId, null, billId,
      { vehicleNo: 'ka 05 mn 4321', fromPlace: 'Hosur', reason: '1' },
      { call: p.call },
    );

    assert.deepEqual(p.asked, ['update_ewb_vehicle']);
    assert.equal(out.vehicleNo, 'KA05MN4321');
    const after = await trx.selectFrom('eway_bills').select(['vehicle_no', 'valid_until'])
      .where('id', '=', billId).executeTakeFirstOrThrow();
    assert.equal(after.vehicle_no, 'KA05MN4321');
    assert.equal(after.valid_until?.getTime(), before.valid_until?.getTime());

    const last = (await events(trx, billId)).at(-1);
    assert.deepEqual(
      { kind: last?.kind, vehicle: last?.vehicle_no, place: last?.from_place, reason: last?.reason_code },
      { kind: 'vehicle_changed', vehicle: 'KA05MN4321', place: 'Hosur', reason: '1' },
    );
  });
});

test('the same vehicle, or a number that is not one, is refused without asking the portal', async () => {
  await withBill(async ({ trx, orgId, billId }) => {
    const p = portal();
    await assert.rejects(
      changeEwayVehicle(trx, orgId, null, billId, { vehicleNo: 'TN01AB1234', fromPlace: 'Hosur', reason: '1' }, { call: p.call }),
      badRequest,
    );
    await assert.rejects(
      changeEwayVehicle(trx, orgId, null, billId, { vehicleNo: 'X1', fromPlace: 'Hosur', reason: '1' }, { call: p.call }),
      badRequest,
    );
    assert.deepEqual(p.asked, []);
  });
});

test('an expired bill cannot change vehicle', async () => {
  await withBill(async ({ trx, orgId, billId }) => {
    await trx.updateTable('eway_bills').set({ valid_until: new Date(Date.now() - HOUR) })
      .where('id', '=', billId).execute();
    const p = portal();
    await assert.rejects(
      changeEwayVehicle(trx, orgId, null, billId, { vehicleNo: 'KA05MN4321', fromPlace: 'Hosur', reason: '1' }, { call: p.call }),
      refusedWith('ewb_expired'),
    );
    assert.deepEqual(p.asked, []);
  });
});

// ── More time ────────────────────────────────────────────────────────────────

test('extension is refused outside the 8 hours either side of expiry', async () => {
  await withBill(async ({ trx, orgId, billId }) => {
    const now = new Date();
    await trx.updateTable('eway_bills').set({ valid_until: new Date(now.getTime() + 20 * HOUR) })
      .where('id', '=', billId).execute();
    const p = portal();
    await assert.rejects(
      extendEwayBill(trx, orgId, null, billId, extension, { now, call: p.call }),
      refusedWith('extend_not_allowed'),
    );
    assert.deepEqual(p.asked, []);
  });
});

test('an extension inside the window moves the expiry and counts itself', async () => {
  await withBill(async ({ trx, orgId, billId }) => {
    const now = new Date();
    await trx.updateTable('eway_bills')
      .set({ valid_until: new Date(now.getTime() + 2 * HOUR), generated_at: new Date(now.getTime() - 30 * HOUR) })
      .where('id', '=', billId).execute();
    const p = portal();
    const out = await extendEwayBill(trx, orgId, null, billId, extension, { now, call: p.call });

    assert.deepEqual(p.asked, ['extend_ewb']);
    assert.equal(out.extendedCount, 1);
    const row = await trx.selectFrom('eway_bills').select(['valid_until', 'extended_count'])
      .where('id', '=', billId).executeTakeFirstOrThrow();
    assert.equal(row.extended_count, 1);
    assert.equal(row.valid_until?.toISOString(), out.validUntil);
    assert.equal((await events(trx, billId)).at(-1)?.kind, 'extended');
  });
});

test('an extension needs a real PIN code and a distance still to go', async () => {
  await withBill(async ({ trx, orgId, billId }) => {
    const now = new Date();
    await trx.updateTable('eway_bills').set({ valid_until: new Date(now.getTime() + HOUR) })
      .where('id', '=', billId).execute();
    const p = portal();
    await assert.rejects(
      extendEwayBill(trx, orgId, null, billId, { ...extension, fromPincode: '0351' }, { now, call: p.call }),
      badRequest,
    );
    await assert.rejects(
      extendEwayBill(trx, orgId, null, billId, { ...extension, remainingDistanceKm: 0 }, { now, call: p.call }),
      badRequest,
    );
    assert.deepEqual(p.asked, []);
  });
});

// ── Cancelling ───────────────────────────────────────────────────────────────

test('a bill cancelled within 24 hours leaves the invoice without it, and frees the IRN', async () => {
  await withBill(async ({ trx, orgId, invoiceId, billId, ewbNo }) => {
    // Registered by the stand-in an hour ago, with its bill still standing.
    await trx.updateTable('einvoices')
      .set({ status: 'submitted', provider: 'fake', irn: `DEMO${'b'.repeat(60)}`, ack_date: new Date(Date.now() - HOUR) })
      .where('invoice_id', '=', invoiceId).execute();
    const p = portal();
    await assert.rejects(
      cancelEinvoice(trx, orgId, null, invoiceId, { reason: '2', remark: '' }, { call: p.call }),
      refusedWith('ewb_active'),
    );

    const out = await cancelEwayBill(trx, orgId, null, billId, { reason: '3', remark: 'Wrong distance' }, { call: p.call });
    assert.equal(out.ewayBillNo, ewbNo);
    const bill = await trx.selectFrom('eway_bills').select(['status', 'cancel_reason'])
      .where('id', '=', billId).executeTakeFirstOrThrow();
    assert.equal(bill.status, 'cancelled');
    assert.equal(bill.cancel_reason, 'Data entry mistake: Wrong distance');
    const inv = await trx.selectFrom('invoices').select('eway_bill_no')
      .where('id', '=', invoiceId).executeTakeFirstOrThrow();
    assert.equal(inv.eway_bill_no, null, 'a cancelled number is not left on the invoice');

    // With the bill gone, the IRN can go too.
    await cancelEinvoice(trx, orgId, null, invoiceId, { reason: '2', remark: '' }, { call: p.call });
    assert.deepEqual(p.asked, ['cancel_ewb', 'cancel_irn']);
  });
});

test('after 24 hours a bill cannot be cancelled', async () => {
  await withBill(async ({ trx, orgId, billId }) => {
    await trx.updateTable('eway_bills').set({ generated_at: new Date(Date.now() - 25 * HOUR) })
      .where('id', '=', billId).execute();
    const p = portal();
    await assert.rejects(
      cancelEwayBill(trx, orgId, null, billId, { reason: '1' }, { call: p.call }),
      refusedWith('ewb_cancel_window_passed'),
    );
    assert.deepEqual(p.asked, []);
  });
});

test('a bill issued with the IRN through NIC is not changed by anything else', async () => {
  await withBill(async ({ trx, orgId, billId }) => {
    await trx.updateTable('eway_bills').set({ provider: 'nic_einvoice' }).where('id', '=', billId).execute();
    const p = portal();
    await assert.rejects(
      cancelEwayBill(trx, orgId, null, billId, { reason: '1' }, { call: p.call }),
      refusedWith('ewb_connection_needed'),
    );
    assert.deepEqual(p.asked, []);
  });
});

test('a cancelled bill can be generated again, and starts clean', async () => {
  await withBill(async ({ trx, orgId, invoiceId, billId }) => {
    const p = portal();
    await cancelEwayBill(trx, orgId, null, billId, { reason: '3' }, { call: p.call });
    const again = await generateEwayBill(
      trx, orgId, { kind: 'invoice', id: invoiceId },
      { vehicleNo: 'TN09ZZ0001', distanceKm: 250 },
      { call: p.call },
    );

    const row = await trx.selectFrom('eway_bills')
      .select(['status', 'cancelled_at', 'cancel_reason', 'extended_count', 'vehicle_no'])
      .where('id', '=', billId).executeTakeFirstOrThrow();
    assert.deepEqual(
      { ...row },
      { status: 'generated', cancelled_at: null, cancel_reason: null, extended_count: 0, vehicle_no: 'TN09ZZ0001' },
    );
    const inv = await trx.selectFrom('invoices').select('eway_bill_no')
      .where('id', '=', invoiceId).executeTakeFirstOrThrow();
    assert.equal(inv.eway_bill_no, again.ewayBillNo);
    assert.deepEqual((await events(trx, billId)).map((e) => e.kind), ['generated', 'cancelled', 'generated']);
  });
});

test('an IRN from NIC whose connection has gone cannot get a stand-in bill against it', async () => {
  await withBill(async ({ trx, orgId, invoiceId, billId }) => {
    const p = portal();
    await cancelEwayBill(trx, orgId, null, billId, { reason: '3' }, { call: p.call });
    await trx.updateTable('einvoices')
      .set({ status: 'submitted', provider: 'nic_einvoice', irn: 'c'.repeat(64), ack_date: new Date() })
      .where('invoice_id', '=', invoiceId).execute();

    await assert.rejects(
      generateEwayBill(
        trx, orgId, { kind: 'invoice', id: invoiceId },
        { vehicleNo: 'TN09ZZ0001', distanceKm: 250 },
        { call: p.call },
      ),
      refusedWith('provider_changed'),
    );
    assert.deepEqual(p.asked, ['cancel_ewb'], 'nothing was generated anywhere');
  });
});

test('the cancellation window is 24 hours from generation', () => {
  const at = new Date('2026-09-12T09:00:00+05:30');
  assert.equal(ewbCancelDeadline(at)?.toISOString(), new Date('2026-09-13T09:00:00+05:30').toISOString());
  assert.equal(ewbCancelDeadline(null), null);
});

test.after(async () => {
  await db.destroy();
});
