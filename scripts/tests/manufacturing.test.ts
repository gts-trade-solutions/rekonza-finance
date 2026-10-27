// Production from a bill of materials, and job work with ITC-04.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/manufacturing.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { stockPosition } from '../../lib/server/reports/stock';
import { recordProduction, saveBom, voidProduction } from '../../lib/server/services/manufacturing';
import { createChallan } from '../../lib/server/services/sales-documents';
import { itc04, jobWorkLines, receiveJobWork } from '../../lib/server/services/job-work';

interface Fixture { trx: Trx; orgId: number; branchId: number; sheet: number; bolt: number; bracket: number; worker: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Fabricator' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'Works', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '7326', kind: 'hsn', description: 'Steel articles', gst_rate_pct: 18, is_active: 1 }).execute();
      const item = async (name: string, qty: string, rate: string) => Number((await trx.insertInto('items').values({
        org_id: orgId, kind: 'goods', name, hsn_sac: '7326', uqc: 'NOS', sale_price: '100.0000', purchase_price: rate, gst_rate_pct: 18,
        track_inventory: 1, opening_stock_qty: qty, opening_stock_rate: rate,
      }).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId,
        sheet: await item('Steel sheet', '100', '50.0000'),
        bolt: await item('Bolt', '1000', '2.0000'),
        bracket: await item('Bracket', '0', '0.0000'),
        worker: Number((await trx.insertInto('contacts').values({
          org_id: orgId, kind: 'vendor', display_name: 'Laser Cutters', state_code: '33', gst_treatment: 'registered', gstin: '33AAACL1234L1Z1',
        } as never).executeTakeFirstOrThrow()).insertId),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const line = async (f: Fixture, itemId: number, date: string) =>
  (await stockPosition(f.trx, f.orgId, date)).lines.find((l) => l.itemId === String(itemId))!;

test('a production uses its components and makes the item at their cost plus overhead', async () => {
  await withFixture(async (f) => {
    const bom = await saveBom(f.trx, f.orgId, { itemId: f.bracket, name: 'Standard', outputQty: 10, lines: [{ itemId: f.sheet, qty: 5 }, { itemId: f.bolt, qty: 40 }] });
    await assert.rejects(saveBom(f.trx, f.orgId, { itemId: f.bracket, name: 'Loop', outputQty: 1, lines: [{ itemId: f.bracket, qty: 1 }] }), /component of itself/);

    // Twenty brackets: ten sheets at ₹50 and eighty bolts at ₹2, plus ₹200 of labour.
    const p = await recordProduction(f.trx, f.orgId, null, { bomId: bom, qty: 20, date: '2026-06-01', branchId: f.branchId, overheadPaise: 200_00 });
    assert.equal(p.costPaise, 860_00);
    assert.equal(p.unitCostPaise, 43_00);
    assert.equal((await line(f, f.sheet, '2026-06-01')).qty, 90);
    assert.equal((await line(f, f.bolt, '2026-06-01')).qty, 920);
    const bracket = await line(f, f.bracket, '2026-06-01');
    assert.deepEqual([bracket.qty, bracket.valuePaise], [20, 860_00]);

    await voidProduction(f.trx, f.orgId, p.id);
    assert.equal((await line(f, f.sheet, '2026-06-01')).qty, 100, 'a void puts the components back');
    assert.equal((await line(f, f.bracket, '2026-06-01')).qty, 0);
  });
});

test('job work: sent, back with waste, ITC-04, and what is still out after a year', async () => {
  await withFixture(async (f) => {
    const dc = await createChallan(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.worker, date: '2025-05-01', challanType: 'job_work',
      lines: [{ itemId: f.sheet, description: 'Steel sheet for cutting', hsnSac: '7326', qty: 20, ratePaise: 50_00 }],
    });
    assert.equal((await line(f, f.sheet, '2025-05-02')).qty, 100, 'still ours, at the job worker');
    const [sent] = await jobWorkLines(f.trx, f.orgId, dc.id);
    await assert.rejects(receiveJobWork(f.trx, f.orgId, null, { challanId: dc.id, date: '2025-07-01', lines: [{ challanLineId: Number(sent.lineId), qtyReceived: 19, qtyWaste: 2 }] }), /Only 20/);
    await receiveJobWork(f.trx, f.orgId, null, {
      challanId: dc.id, date: '2025-07-01', jobWorkerChallanNo: 'LC/77', natureOfJob: 'Laser cutting',
      lines: [{ challanLineId: Number(sent.lineId), qtyReceived: 15, qtyWaste: 2 }],
    });
    assert.equal((await line(f, f.sheet, '2025-07-01')).qty, 98, 'the waste has left stock');

    const half = await itc04(f.trx, f.orgId, '2025-04-01', '2025-09-30');
    assert.equal(half.sent.length, 1);
    assert.equal(half.sent[0].valuePaise, 1_000_00);
    assert.deepEqual([half.received[0].qtyReceived, half.received[0].qtyWaste, half.received[0].jobWorkerChallanNo], [15, 2, 'LC/77']);
    assert.equal(half.overdue.length, 0);

    const later = await itc04(f.trx, f.orgId, '2026-04-01', '2026-09-30');
    assert.equal(later.overdue[0].outstanding, 3, 'three sheets still out a year after they went');
    await receiveJobWork(f.trx, f.orgId, null, { challanId: dc.id, date: '2026-06-01', lines: [{ challanLineId: Number(sent.lineId), qtyReceived: 3 }] });
    const ch = await f.trx.selectFrom('delivery_challans').select('status').where('id', '=', dc.id).executeTakeFirstOrThrow();
    assert.equal(ch.status, 'returned', 'everything back');
  });
});

test.after(async () => {
  await db.destroy();
});
