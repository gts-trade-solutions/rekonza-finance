// The auditors' FIFO valuation test (status review 7, item 5), in a perpetual
// book and in a periodic one: two bills, a sale, a return to the supplier with
// the goods, a return from the customer, a write-off, and then a back-dated
// bill. At every step the Inventory Valuation report, the item's FIFO layers,
// the Inventory account (in total and item by item) and cost of goods sold in
// the P&L have to agree to the paisa.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/fifo-variance.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { createCreditNote } from '../../lib/server/services/sales-documents';
import { createVendorCredit, voidVendorCredit } from '../../lib/server/services/purchase-documents';
import { createAdjustment } from '../../lib/server/services/stock-changes';
import { inventoryInLedger, profitAndLoss } from '../../lib/server/reports/statements';
import { fifoLayers, stockPosition } from '../../lib/server/reports/stock';
import { itemLedgerValues, switchToPerpetual } from '../../lib/server/services/stock-ledger';
import { stockReconciliation } from '../../lib/server/reports/stock-reconciliation';

interface Fixture { trx: Trx; orgId: number; branchId: number; customerId: number; vendorId: number; itemId: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'FIFO Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const mk = async (values: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values(values as never).executeTakeFirstOrThrow()).insertId);
      const customerId = await mk({ org_id: orgId, kind: 'customer', display_name: 'Sharma Traders', gst_treatment: 'unregistered', state_code: '33' });
      const vendorId = await mk({ org_id: orgId, kind: 'vendor', display_name: 'Local Vendor', gst_treatment: 'unregistered', state_code: '33' });
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '8708', kind: 'hsn', description: 'Parts', gst_rate_pct: 18, is_active: 1 }).execute();
      // A FIFO item with no opening stock.
      const itemId = Number((await trx.insertInto('items').values({
        org_id: orgId, kind: 'goods', name: 'Brake pad', sku: 'BP-1', hsn_sac: '8708', uqc: 'NOS',
        sale_price: '200.0000', purchase_price: '100.0000', gst_rate_pct: 18, track_inventory: 1, valuation_method: 'fifo',
        sale_account_id: acc[CODE.SALES], purchase_account_id: acc[CODE.PURCHASES],
      }).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, customerId, vendorId, itemId });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const buy = (f: Fixture, date: string, qty: number, ratePaise: number, no: string) =>
  createBill(f.trx, f.orgId, null, {
    branchId: f.branchId, vendorId: f.vendorId, vendorInvoiceNo: no, date, dueDate: date, lines: [{ itemId: f.itemId, qty, ratePaise }],
  });

/** Every figure the auditors set side by side, on one date. */
async function figures(f: Fixture, asOf: string) {
  const pos = await stockPosition(f.trx, f.orgId, asOf, { includeArchived: true });
  const line = pos.lines.find((l) => l.itemId === String(f.itemId))!;
  const layers = (await fifoLayers(f.trx, f.orgId, asOf)).get(f.itemId) ?? [];
  // The layers' own value of what is on hand, from the newest back.
  let left = line.qty;
  let fromLayers = 0;
  for (const l of layers) { const take = Math.min(left, l.qty); fromLayers += (l.cost / l.qty) * take; left -= take; }
  const pnl = await profitAndLoss(f.trx, f.orgId, '2026-04-01', asOf);
  return {
    qty: line.qty,
    valuation: line.valuePaise,
    layers: Math.round(fromLayers),
    ledger: await inventoryInLedger(f.trx, f.orgId, asOf),
    itemLedger: (await itemLedgerValues(f.trx, f.orgId, asOf)).get(f.itemId) ?? 0,
    // Opening stock + purchases - closing stock on a periodic book; the COGS account on a perpetual one.
    cogs: pnl.costOfGoodsSoldPaise,
    closingInStatements: pnl.closingStockPaise,
  };
}

async function scenario(f: Fixture, perpetual: boolean) {
  if (perpetual) await switchToPerpetual(f.trx, f.orgId, null, '2026-04-01');
  const agree = async (asOf: string, qty: number, value: number, cogs: number) => {
    const x = await figures(f, asOf);
    assert.equal(x.qty, qty, `${asOf}: quantity`);
    assert.equal(x.valuation, value, `${asOf}: valuation report`);
    assert.equal(x.layers, value, `${asOf}: FIFO layers`);
    if (perpetual) {
      assert.equal(x.ledger, value, `${asOf}: Inventory account`);
      assert.equal(x.itemLedger, value, `${asOf}: Inventory account for the item`);
      assert.equal(x.closingInStatements, 0, `${asOf}: nothing left for the statements to add`);
    } else {
      assert.equal(x.ledger, 0, `${asOf}: a periodic book posts no Inventory`);
      assert.equal(x.closingInStatements, value, `${asOf}: the statements carry the valuation`);
    }
    assert.equal(x.cogs, cogs, `${asOf}: cost of goods sold`);
  };

  // 1. Opening 0; bill 10 @ ₹100, then 10 @ ₹120.
  const b1 = await buy(f, '2026-04-02', 10, 10_000, 'INV-A1');
  const b2 = await buy(f, '2026-04-03', 10, 12_000, 'INV-A2');
  await agree('2026-04-03', 20, 220_000, 0);

  // 2. Invoice 15: COGS ₹1,600 (10 x 100 + 5 x 120); closing 5 @ ₹120 = ₹600.
  const inv = await createInvoice(f.trx, f.orgId, null, {
    branchId: f.branchId, customerId: f.customerId, date: '2026-04-05', dueDate: '2026-04-05', status: 'approved',
    lines: [{ itemId: f.itemId, qty: 15, ratePaise: 20_000 }],
  });
  await agree('2026-04-05', 5, 60_000, 160_000);

  // 3. Return 2 to the vendor out of the second bill: stock 3, value follows the layer (3 @ 120).
  const b2Line = await f.trx.selectFrom('bill_lines').select('id').where('bill_id', '=', b2.id).executeTakeFirstOrThrow();
  const vc = await createVendorCredit(f.trx, f.orgId, null, {
    branchId: f.branchId, vendorId: f.vendorId, date: '2026-04-06', reason: 'Goods returned - damaged', againstBillId: b2.id,
    amountPaise: 0, lines: [{ itemId: f.itemId, billLineId: b2Line.id, qty: 2 }],
  });
  assert.ok([24_000, 28_300].includes(vc.totalPaise), `two at ₹120, with GST as the supply has it: ${vc.totalPaise}`);
  await agree('2026-04-06', 3, 36_000, 160_000);
  // More than came in on the bill cannot go back.
  await assert.rejects(createVendorCredit(f.trx, f.orgId, null, {
    branchId: f.branchId, vendorId: f.vendorId, date: '2026-04-06', reason: 'Again', againstBillId: b2.id,
    amountPaise: 0, lines: [{ itemId: f.itemId, billLineId: b2Line.id, qty: 9 }],
  }), /only 8/);

  // 4. The customer returns 1: back at its cost, the last unit that went out (₹120).
  await createCreditNote(f.trx, f.orgId, null, {
    branchId: f.branchId, customerId: f.customerId, date: '2026-04-07', reason: 'Sales return', againstInvoiceId: inv.id,
    lines: [{ itemId: f.itemId, qty: 1, ratePaise: 20_000 }],
  });
  await agree('2026-04-07', 4, 48_000, 148_000);

  // 5. One written off as damaged: out at ₹120, into cost of goods sold.
  await createAdjustment(f.trx, f.orgId, null, { itemId: f.itemId, date: '2026-04-08', qtyDelta: -1, reason: 'damage', notes: 'Cracked in the store' });
  await agree('2026-04-08', 3, 36_000, 160_000);
  // 6. At any date, not only month end: the days between agree as well.
  await agree('2026-04-04', 20, 220_000, 0);

  // 7. A bill back-dated to before the sale (5 @ ₹80): FIFO now says the sale
  // took those first. The sale's entry stands; the difference is posted as a
  // stock cost variance on each later day it changes, naming the bill.
  await buy(f, '2026-04-01', 5, 8_000, 'INV-A0');
  await agree('2026-04-05', 10, 120_000, 140_000);
  await agree('2026-04-08', 8, 96_000, 140_000);
  if (perpetual) {
    const variances = await f.trx.selectFrom('journal_entries').select(['entry_date', 'memo']).where('org_id', '=', f.orgId)
      .where('source_type', '=', 'stock_variance').where('reversal_of_entry_id', 'is', null).orderBy('entry_date').execute();
    assert.ok(variances.length >= 1, 'a visible cost variance');
    assert.ok(variances.every((v) => /INV-A0/.test(v.memo ?? '')), 'each names the back-dated bill');
  }

  // The reconciliation report reads ₹0.00 for the item and in total.
  const rec = await stockReconciliation(f.trx, f.orgId, '2026-04-08');
  assert.equal(rec.totals.valuationPaise, 96_000);
  assert.equal(rec.totals.variancePaise, 0);
  assert.equal(rec.lines.find((l) => l.itemId === String(f.itemId))?.variancePaise, 0);
  assert.equal(rec.method, perpetual ? 'perpetual' : 'periodic');

  // Voiding the return puts its goods back in the layers and the ledger follows.
  await voidVendorCredit(f.trx, f.orgId, null, vc.id, 'Returned by mistake');
  await agree('2026-04-08', 10, 120_000, 140_000);
  void b1;
}

test('FIFO, perpetual book: valuation, layers, Inventory account and COGS agree at every step', async () => {
  await withFixture((f) => scenario(f, true));
});

test('FIFO, periodic book: valuation, layers and COGS agree at every step', async () => {
  await withFixture((f) => scenario(f, false));
});

test('a vendor credit can be raised on a bill already paid; the rest stays on account', async () => {
  await withFixture(async (f) => {
    const b = await buy(f, '2026-04-02', 10, 10_000, 'PAID-1');
    await f.trx.updateTable('bills').set({ amount_paid: '100000.0000', status: 'paid' }).where('id', '=', b.id).execute();
    const vc = await createVendorCredit(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendorId, date: '2026-04-03', reason: 'Goods returned', againstBillId: b.id, amountPaise: 0,
      lines: [{ itemId: f.itemId, qty: 1 }],
    });
    const row = await f.trx.selectFrom('vendor_credits').select(['status', 'applied_amount']).where('id', '=', vc.id).executeTakeFirstOrThrow();
    assert.equal(row.status, 'open');
    assert.equal(Number(row.applied_amount), 0);
    const { rows } = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM vendor_credit_lines WHERE vendor_credit_id = ${vc.id}`.execute(f.trx);
    assert.equal(Number(rows[0].n), 1);
  });
});

test.after(() => db.destroy());
