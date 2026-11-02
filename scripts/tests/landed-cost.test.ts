// Landed cost, as Zoho Books has it (services/landed-cost.ts, migration 102):
// freight on one bill spread over the goods of another, by quantity, by value
// or by hand, into their stock value from the freight bill's date; never more
// than the charge; taken off again; and moved into Inventory on a perpetual book.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/landed-cost.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createBill, voidBill } from '../../lib/server/services/purchases';
import { stockPosition } from '../../lib/server/reports/stock';
import { switchToPerpetual } from '../../lib/server/services/stock-ledger';
import { allocateLandedCost, chargeLines, goodsLines, listLandedCosts, removeLandedCost, splitByWeight } from '../../lib/server/services/landed-cost';

interface Book { trx: Trx; orgId: number; goodsBill: number; freightBill: number; freightLine: number; itemA: number; itemB: number; acc: Record<string, number> }

async function withBook(fn: (b: Book) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Landed Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AABCL9191L1Z0' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId) as Record<string, number>;
      const vendor = (name: string) => trx.insertInto('contacts').values({ org_id: orgId, kind: 'vendor', display_name: name, state_code: '33', gst_treatment: 'unregistered' } as never)
        .executeTakeFirstOrThrow().then((r) => Number(r.insertId));
      const item = (name: string) => trx.insertInto('items').values({ org_id: orgId, name, kind: 'goods', track_inventory: 1, uqc: 'NOS', purchase_price: '0.0000', sale_price: '0.0000' } as never)
        .executeTakeFirstOrThrow().then((r) => Number(r.insertId));
      const itemA = await item('Pump');
      const itemB = await item('Valve');
      const supplier = await vendor('Pump Works');
      const transporter = await vendor('Fast Freight');
      const goods = await createBill(trx, orgId, null, {
        branchId, vendorId: supplier, vendorInvoiceNo: 'PW-1', date: '2026-09-05', dueDate: '2026-10-05', status: 'open',
        lines: [{ itemId: itemA, qty: 10, ratePaise: 100_00, gstRatePct: 0 }, { itemId: itemB, qty: 30, ratePaise: 50_00, gstRatePct: 0 }],
      } as never);
      // The transporter's bill: ₹800 freight, its GST claimable, so ₹800 is what it cost.
      const freight = await createBill(trx, orgId, null, {
        branchId, vendorId: transporter, vendorInvoiceNo: 'FF-9', date: '2026-09-08', dueDate: '2026-10-08', status: 'open',
        lines: [{ description: 'Freight Chennai to godown', accountId: acc[CODE.FREIGHT], qty: 1, ratePaise: 800_00, gstRatePct: 18 }],
      } as never);
      const freightLine = Number((await trx.selectFrom('bill_lines').select('id').where('bill_id', '=', freight.id).executeTakeFirstOrThrow()).id);
      await fn({ trx, orgId, goodsBill: goods.id, freightBill: freight.id, freightLine, itemA, itemB, acc });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const valueOf = async (trx: Trx, orgId: number, asOf: string) => {
  const s = await stockPosition(trx, orgId, asOf);
  return { total: s.totalValuePaise, by: Object.fromEntries(s.lines.map((l) => [l.name, l.valuePaise])) };
};

test('split to the paisa: the parts always add up', () => {
  assert.deepEqual(splitByWeight(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(splitByWeight(800_00, [10, 30]), [200_00, 600_00]);
  assert.equal(splitByWeight(99_99, [3, 7, 11]).reduce((t, n) => t + n, 0), 99_99);
  assert.throws(() => splitByWeight(100, [0, 0]), /nothing to spread it by/);
});

test('freight spread by quantity raises the stock value from the freight bill’s date, and comes off again', async () => {
  await withBook(async ({ trx, orgId, goodsBill, freightLine }) => {
    const charges = await chargeLines(trx, orgId);
    assert.deepEqual(charges.map((c) => [c.description, c.costPaise, c.leftPaise]), [['Freight Chennai to godown', 800_00, 800_00]], 'the GST is credit, not cost');
    assert.equal((await valueOf(trx, orgId, '2026-09-30')).total, 2_500_00);

    const r = await allocateLandedCost(trx, orgId, null, { chargeLineId: freightLine, goodsBillId: goodsBill, method: 'quantity' });
    assert.equal(r.totalPaise, 800_00, 'all of it, when no amount is given');
    assert.equal(r.journalEntryId, null, 'a periodic book posts nothing');
    const goods = await goodsLines(trx, orgId, goodsBill);
    assert.deepEqual(goods.map((g) => [g.item, g.landedPaise, g.unitCostPaise]), [['Pump', 200_00, 120_00], ['Valve', 600_00, 70_00]]);

    const after = await valueOf(trx, orgId, '2026-09-30');
    assert.equal(after.total, 3_300_00);
    assert.deepEqual(after.by, { Pump: 1_200_00, Valve: 2_100_00 });
    assert.equal((await valueOf(trx, orgId, '2026-09-06')).total, 2_500_00, 'before the freight bill, the goods were worth what they cost');
    assert.deepEqual(await chargeLines(trx, orgId), [], 'nothing left of the charge');
    await assert.rejects(allocateLandedCost(trx, orgId, null, { chargeLineId: freightLine, goodsBillId: goodsBill, method: 'value', amountPaise: 1 }), /All of that charge has been spread/);

    const list = await listLandedCosts(trx, orgId, goodsBill);
    assert.equal(list.length, 1);
    assert.equal(list[0].charge.vendor, 'Fast Freight');
    await removeLandedCost(trx, orgId, null, Number(list[0].id));
    assert.equal((await valueOf(trx, orgId, '2026-09-30')).total, 2_500_00);
    assert.equal((await chargeLines(trx, orgId))[0].leftPaise, 800_00);
  });
});

test('by value and by hand, never more than is left, only goods, only bills that stand', async () => {
  await withBook(async ({ trx, orgId, goodsBill, freightBill, freightLine }) => {
    await allocateLandedCost(trx, orgId, null, { chargeLineId: freightLine, goodsBillId: goodsBill, method: 'value', amountPaise: 500_00 });
    assert.deepEqual((await goodsLines(trx, orgId, goodsBill)).map((g) => g.landedPaise), [200_00, 300_00], '₹1,000 and ₹1,500 of goods share ₹500 as 2 to 3');
    assert.equal((await chargeLines(trx, orgId))[0].leftPaise, 300_00);

    const [pump, valve] = await goodsLines(trx, orgId, goodsBill);
    await assert.rejects(allocateLandedCost(trx, orgId, null, { chargeLineId: freightLine, goodsBillId: goodsBill, method: 'manual', manual: [{ lineId: Number(pump.lineId), amountPaise: 301_00 }] }), /Only ₹300.00 of that charge is left/);
    await assert.rejects(allocateLandedCost(trx, orgId, null, { chargeLineId: freightLine, goodsBillId: goodsBill, method: 'manual', manual: [{ lineId: freightLine, amountPaise: 10_00 }] }), /not a stock line/);
    await allocateLandedCost(trx, orgId, null, { chargeLineId: freightLine, goodsBillId: goodsBill, method: 'manual', manual: [{ lineId: Number(valve.lineId), amountPaise: 300_00 }] });
    assert.deepEqual((await goodsLines(trx, orgId, goodsBill)).map((g) => g.landedPaise), [200_00, 600_00]);

    const pumpLine = Number(pump.lineId);
    await assert.rejects(allocateLandedCost(trx, orgId, null, { chargeLineId: pumpLine, goodsBillId: goodsBill, method: 'quantity' }), /not goods/);
    await assert.rejects(allocateLandedCost(trx, orgId, null, { chargeLineId: freightLine, goodsBillId: freightBill, method: 'quantity' }), /no stock items/);
    await trx.updateTable('bills').set({ status: 'void' }).where('id', '=', goodsBill).execute();
    await assert.rejects(allocateLandedCost(trx, orgId, null, { chargeLineId: freightLine, goodsBillId: goodsBill, method: 'quantity' }), /void/);
    await assert.rejects(allocateLandedCost(trx, orgId + 1, null, { chargeLineId: freightLine, goodsBillId: goodsBill, method: 'quantity' }), /does not exist/);
  });
});

test('a perpetual book moves the landed cost into Inventory, and reverses it when taken off', async () => {
  await withBook(async ({ trx, orgId, goodsBill, freightLine, acc }) => {
    await switchToPerpetual(trx, orgId, null, '2026-09-01');
    const r = await allocateLandedCost(trx, orgId, null, { chargeLineId: freightLine, goodsBillId: goodsBill, method: 'quantity', amountPaise: 400_00 });
    assert.ok(r.journalEntryId);
    const lines = await trx.selectFrom('journal_lines').select(['account_id', 'debit', 'credit']).where('entry_id', '=', r.journalEntryId!).execute();
    const dr = lines.find((l) => Number(l.debit) > 0)!;
    const cr = lines.find((l) => Number(l.credit) > 0)!;
    assert.deepEqual([dr.account_id, Number(dr.debit)], [acc[CODE.INVENTORY], 400]);
    assert.deepEqual([cr.account_id, Number(cr.credit)], [acc[CODE.FREIGHT], 400], 'out of freight, into stock');

    await removeLandedCost(trx, orgId, null, r.id);
    const reversal = await trx.selectFrom('journal_entries').select('id').where('org_id', '=', orgId).where('reversal_of_entry_id', '=', r.journalEntryId!).executeTakeFirst();
    assert.ok(reversal, 'reversed, not deleted');
  });
});

test('voiding the freight bill takes its landed cost off the goods', async () => {
  await withBook(async ({ trx, orgId, goodsBill, freightBill, freightLine }) => {
    await allocateLandedCost(trx, orgId, null, { chargeLineId: freightLine, goodsBillId: goodsBill, method: 'quantity' });
    await voidBill(trx, orgId, null, freightBill, 'Entered twice');
    assert.deepEqual(await listLandedCosts(trx, orgId, goodsBill), []);
    assert.equal((await valueOf(trx, orgId, '2026-09-30')).total, 2_500_00);
  });
});

test.after(async () => {
  await db.destroy();
});
