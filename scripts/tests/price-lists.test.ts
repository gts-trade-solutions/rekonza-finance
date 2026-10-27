// Price lists: a percentage on every item, or rates for named items, charged
// to the customers on them when a line names no price of its own.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/price-lists.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { pricesFor, savePriceList } from '../../lib/server/services/price-lists';

test('percentage and per-item lists, and an inactive one', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Price Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '8708', kind: 'hsn', description: 'Parts', gst_rate_pct: 18, is_active: 1 }).execute();
      const item = async (name: string, price: string) => Number((await trx.insertInto('items').values({
        org_id: orgId, kind: 'goods', name, hsn_sac: '8708', uqc: 'NOS', sale_price: price, purchase_price: '1.0000', gst_rate_pct: 18, track_inventory: 0,
      }).executeTakeFirstOrThrow()).insertId);
      const pad = await item('Brake pad', '500.0000');
      const disc = await item('Disc', '1200.0000');
      const customer = async (name: string, list: number | null) => Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'customer', display_name: name, state_code: '33', gst_treatment: 'consumer', price_list_id: list,
      } as never).executeTakeFirstOrThrow()).insertId);

      const dealers = await savePriceList(trx, orgId, { name: 'Dealers', basis: 'percent', percent: -10 });
      const contract = await savePriceList(trx, orgId, { name: 'Fleet contract', basis: 'per_item', items: [{ itemId: pad, ratePaise: 400_00 }] });
      await assert.rejects(savePriceList(trx, orgId, { name: 'Dealers', basis: 'percent', percent: 5 }), /already a price list/);

      const dealer = await customer('Dealer', dealers);
      const fleet = await customer('Fleet', contract);
      const walkIn = await customer('Walk-in', null);

      assert.equal((await pricesFor(trx, orgId, dealer))!.get(pad), 450_00);
      assert.equal((await pricesFor(trx, orgId, fleet))!.get(pad), 400_00);
      assert.equal((await pricesFor(trx, orgId, fleet))!.get(disc), 1_200_00, 'not named: its own price');
      assert.equal(await pricesFor(trx, orgId, walkIn), null);

      const sell = (customerId: number, itemId: number, ratePaise?: number) => createInvoice(trx, orgId, null, {
        branchId, customerId, date: '2026-06-01', dueDate: '2026-06-01', status: 'approved',
        lines: [{ itemId, description: 'Part', hsnSac: '8708', qty: 2, ratePaise, gstRatePct: 18 }],
      });
      assert.equal((await sell(dealer, disc)).totalPaise, 2_549_00, 'two discs at ₹1,080: ₹2,548.80 with GST, to the rupee');
      assert.equal((await sell(dealer, disc, 1_000_00)).totalPaise, 2_360_00, 'a price typed on the line stands');

      await savePriceList(trx, orgId, { name: 'Dealers', basis: 'percent', percent: -10, isActive: false }, dealers);
      assert.equal(await pricesFor(trx, orgId, dealer), null, 'an inactive list charges item prices');
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test.after(async () => {
  await db.destroy();
});
