// The rest of the item master: serial numbers traced in and out, a sale above
// MRP flagged, and the bell told of stock below its minimum and of batches
// expiring.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/item-master.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice, postInvoice, voidInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { billFromGoodsReceipt, receiveGoods } from '../../lib/server/services/order-flow';
import { createCreditNote } from '../../lib/server/services/sales-documents';
import { recordSerials, serialHistory, serialStock } from '../../lib/server/services/serials';
import { alertBook } from '../../lib/server/services/stock-alerts';
import { saveCustomRole } from '../../lib/server/services/users';

async function book(trx: Trx, name: string) {
  const orgId = Number((await trx.insertInto('organizations').values({ name }).executeTakeFirstOrThrow()).insertId);
  const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'Shop', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
  await installChartOfAccounts(trx, orgId);
  await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '8517', kind: 'hsn', description: 'Phones', gst_rate_pct: 18, is_active: 1 }).execute();
  const itemId = Number((await trx.insertInto('items').values({
    org_id: orgId, kind: 'goods', name: 'Phone', hsn_sac: '8517', uqc: 'NOS', sale_price: '10000.0000', purchase_price: '8000.0000',
    mrp: '11000.0000', gst_rate_pct: 18, track_inventory: 1, track_serials: 1,
  }).executeTakeFirstOrThrow()).insertId);
  const vendor = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'vendor', display_name: 'Distributor', state_code: '33', gst_treatment: 'unregistered' } as never).executeTakeFirstOrThrow()).insertId);
  const customer = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', display_name: 'Walk-in', state_code: '33', gst_treatment: 'consumer' } as never).executeTakeFirstOrThrow()).insertId);
  return { orgId, branchId, itemId, vendor, customer };
}

/**
 * A call that has to be refused, inside a savepoint: in the app each request
 * is its own transaction, so what the refused call wrote before failing is
 * undone with it. Here it has to be undone by hand.
 */
async function refused(trx: Trx, call: () => Promise<unknown>, why: RegExp) {
  await sql`SAVEPOINT refused`.execute(trx);
  await assert.rejects(call(), why);
  await sql`ROLLBACK TO SAVEPOINT refused`.execute(trx);
}

async function rolledBack(fn: (trx: Trx) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => { await fn(trx); throw rollback; });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test('serial numbers: named coming in, checked going out, back in stock when the sale is voided', async () => {
  await rolledBack(async (trx) => {
    const { orgId, branchId, itemId, vendor, customer } = await book(trx, 'Phones');
    const onHand = async () => (await serialStock(trx, orgId, itemId)).map((s) => s.serialNo).sort();
    const buy = (no: string, qty: number, serials?: string[]) => createBill(trx, orgId, null, {
      branchId, vendorId: vendor, vendorInvoiceNo: no, date: '2026-06-01', dueDate: '2026-06-30', status: 'open',
      lines: [{ itemId, qty, ratePaise: 8000_00, gstRatePct: 18, serials }],
    } as never);
    const sell = (qty: number, serials: string[] | undefined, status: 'approved' | 'draft' = 'approved') => createInvoice(trx, orgId, null, {
      branchId, customerId: customer, date: '2026-06-10', dueDate: '2026-06-10', status,
      lines: [{ itemId, description: 'Phone', hsnSac: '8517', qty, ratePaise: 9000_00, gstRatePct: 18, serials }],
    });

    await refused(trx, () => buy('D-0', 3, ['A1', 'A2']), /3 of Phone, but 2 serial/);
    await refused(trx, () => buy('D-0', 2, ['A1', 'a1']), /named twice/);
    const bill = await buy('D-1', 3, ['A1', 'A2', 'A3']);
    assert.deepEqual(bill.warnings, []);
    assert.deepEqual(await onHand(), ['A1', 'A2', 'A3']);
    await refused(trx, () => buy('D-2', 1, ['A2']), /A2 is already in stock/);

    // Sold: it leaves stock. A piece that is not here cannot be sold.
    const inv = await sell(1, ['A2']);
    assert.deepEqual(await onHand(), ['A1', 'A3']);
    await refused(trx, () => sell(1, ['A2']), /A2 is not in stock/);
    await refused(trx, () => sell(1, ['ZZ9']), /ZZ9 is not in stock/);

    // A draft holds its numbers without taking them; issuing it checks them.
    const draft = await sell(1, ['A3'], 'draft');
    assert.deepEqual(await onHand(), ['A1', 'A3'], 'a draft is not a sale');
    await sell(1, ['A3']);
    await refused(trx, () => postInvoice(trx, orgId, null, draft.id), /A3 is not in stock/);

    // Voided, the sale stops counting and the piece is back.
    await voidInvoice(trx, orgId, null, inv.id, 'Raised against the wrong customer');
    assert.deepEqual(await onHand(), ['A1', 'A2']);

    // The warranty question: in on the bill, out on the invoice, which was voided.
    const [h] = await serialHistory(trx, orgId, 'A2');
    assert.equal(h.itemName, 'Phone');
    assert.equal(h.inStock, true);
    assert.deepEqual(h.moves.map((m) => [m.docType, m.direction, m.live, m.party]), [
      ['bill', 1, true, 'Distributor'],
      ['invoice', -1, false, 'Walk-in'],
    ]);

    // A line naming none is let through, with a warning.
    const unnamed = await buy('D-3', 2);
    assert.match(unnamed.warnings.join(' '), /Phone: 2 piece\(s\) came in with no serial numbers/);
  });
});

test('serials on a receipt note are not named again on its bill; returns and write-offs move them', async () => {
  await rolledBack(async (trx) => {
    const { orgId, branchId, itemId, vendor, customer } = await book(trx, 'Phones Two');
    const onHand = async () => (await serialStock(trx, orgId, itemId)).map((s) => s.serialNo).sort();

    const grn = await receiveGoods(trx, orgId, null, {
      branchId, vendorId: vendor, date: '2026-06-01', lines: [{ itemId, qty: 2, ratePaise: 8000_00, gstRatePct: 18, serials: ['G1', 'G2'] }],
    });
    assert.deepEqual(await onHand(), ['G1', 'G2']);
    const lineId = Number((await trx.selectFrom('goods_receipt_lines').select('id').where('receipt_id', '=', grn.id).executeTakeFirstOrThrow()).id);
    await billFromGoodsReceipt(trx, orgId, null, grn.id, { vendorInvoiceNo: 'DST-1', date: '2026-06-03', dueDate: '2026-07-03', lines: [{ lineId, qty: 2 }] });
    assert.deepEqual(await onHand(), ['G1', 'G2'], 'billed from the note: the same two pieces, not four');

    const inv = await createInvoice(trx, orgId, null, {
      branchId, customerId: customer, date: '2026-06-10', dueDate: '2026-06-10', status: 'approved',
      lines: [{ itemId, description: 'Phone', hsnSac: '8517', qty: 1, ratePaise: 9000_00, gstRatePct: 18, serials: ['G1'] }],
    });
    assert.deepEqual(await onHand(), ['G2']);
    await refused(trx, () => createCreditNote(trx, orgId, null, {
      branchId, customerId: customer, date: '2026-06-12', reason: 'Returned', againstInvoiceId: inv.id,
      lines: [{ itemId, description: 'Phone', hsnSac: '8517', qty: 1, ratePaise: 9000_00, gstRatePct: 18, serials: ['G2'] }],
    }), /G2 is already in stock/);
    await createCreditNote(trx, orgId, null, {
      branchId, customerId: customer, date: '2026-06-12', reason: 'Returned', againstInvoiceId: inv.id,
      lines: [{ itemId, description: 'Phone', hsnSac: '8517', qty: 1, ratePaise: 9000_00, gstRatePct: 18, serials: ['G1'] }],
    });
    assert.deepEqual(await onHand(), ['G1', 'G2'], 'back on the return');

    // Written off by adjustment.
    const adj = Number((await trx.insertInto('stock_adjustments').values({
      org_id: orgId, item_id: itemId, adjust_date: '2026-06-20', qty_delta: '-1', reason: 'damage',
    }).executeTakeFirstOrThrow()).insertId);
    await recordSerials(trx, orgId, { type: 'adjustment', id: adj }, -1, [{ lineId: null, itemId, qty: -1, serials: ['G2'] }], { check: true });
    assert.deepEqual(await onHand(), ['G1']);

    // An item that is not tracked takes no numbers.
    const plain = Number((await trx.insertInto('items').values({ org_id: orgId, kind: 'goods', name: 'Cable', uqc: 'NOS', track_inventory: 1 }).executeTakeFirstOrThrow()).insertId);
    await refused(trx, () => receiveGoods(trx, orgId, null, {
      branchId, vendorId: vendor, date: '2026-06-01', lines: [{ itemId: plain, qty: 1, ratePaise: 100_00, serials: ['C1'] }],
    }), /Cable is not tracked by serial number/);
  });
});

test('a sale above MRP is flagged, not refused', async () => {
  await rolledBack(async (trx) => {
    const { orgId, branchId, itemId, customer } = await book(trx, 'Phones Three');
    await trx.updateTable('items').set({ track_serials: 0 }).where('id', '=', itemId).execute();
    const sell = (ratePaise: number) => createInvoice(trx, orgId, null, {
      branchId, customerId: customer, date: '2026-06-10', dueDate: '2026-06-10', status: 'draft',
      lines: [{ itemId, description: 'Phone', hsnSac: '8517', qty: 2, ratePaise, gstRatePct: 18 }],
    });
    // ₹9,000 + 18% = ₹10,620 a unit, under the ₹11,000 MRP.
    assert.deepEqual(((await sell(9000_00)).warnings ?? []).filter((w) => /MRP/.test(w)), []);
    // ₹9,500 + 18% = ₹11,210 a unit.
    const over = await sell(9500_00);
    assert.match((over.warnings ?? []).join(' '), /Phone goes for ₹11210\.00 a unit with tax, above its MRP of ₹11000\.00/);
  });
});

test('stock alerts: below the minimum, and batches expired or about to, told once to those who see inventory', async () => {
  await rolledBack(async (trx) => {
    const { orgId, branchId, itemId, vendor } = await book(trx, 'Alerts');
    await trx.updateTable('items').set({ track_serials: 0, min_level: '5' }).where('id', '=', itemId).execute();
    const syrup = Number((await trx.insertInto('items').values({
      org_id: orgId, kind: 'goods', name: 'Syrup', uqc: 'BTL', purchase_price: '50.0000', gst_rate_pct: 12, track_inventory: 1, track_batches: 1,
    }).executeTakeFirstOrThrow()).insertId);
    const admin = Number((await trx.insertInto('users').values({ org_id: orgId, name: 'Owner', email: `o-${orgId}@example.test`, role: 'admin' }).executeTakeFirstOrThrow()).insertId);
    const clerkRole = await saveCustomRole(trx, orgId, { name: 'Counter', baseRole: 'sales', permissions: { sales: ['view'] } });
    await trx.insertInto('users').values({ org_id: orgId, name: 'Clerk', email: `c-${orgId}@example.test`, role: 'sales', custom_role_id: clerkRole }).execute();

    await createBill(trx, orgId, null, {
      branchId, vendorId: vendor, vendorInvoiceNo: 'A-1', date: '2026-06-01', dueDate: '2026-06-30', status: 'open',
      lines: [
        { itemId, qty: 3, ratePaise: 8000_00, gstRatePct: 18 },
        { itemId: syrup, qty: 4, ratePaise: 50_00, gstRatePct: 12, batch: { batchNo: 'OLD', expiryDate: '2026-06-10' } },
        { itemId: syrup, qty: 6, ratePaise: 50_00, gstRatePct: 12, batch: { batchNo: 'SOON', expiryDate: '2026-07-01' } },
        { itemId: syrup, qty: 9, ratePaise: 50_00, gstRatePct: 12, batch: { batchNo: 'LATER', expiryDate: '2027-01-01' } },
      ],
    } as never);

    assert.equal(await alertBook(trx, orgId, '2026-06-15'), 2, 'two alerts, to the one person who sees inventory');
    const bell = await trx.selectFrom('notifications').select(['user_id', 'kind', 'title', 'body']).where('org_id', '=', orgId).orderBy('id').execute();
    assert.deepEqual(bell.map((n) => [n.user_id, n.kind]), [[admin, 'stock_short'], [admin, 'batch_expiry']]);
    assert.equal(bell[0].title, '1 item at or below the minimum level');
    assert.equal(bell[0].body, 'Phone: 3 nos left, minimum 5');
    assert.equal(bell[1].title, '1 batch expired with stock, 1 expiring within 30 days');
    assert.equal(bell[1].body, 'Syrup batch OLD: 4 expired on 2026-06-10; Syrup batch SOON: 6 expire on 2026-07-01');

    assert.equal(await alertBook(trx, orgId, '2026-06-15'), 0, 'not again the same day');
  });
});

test.after(async () => {
  await db.destroy();
});
