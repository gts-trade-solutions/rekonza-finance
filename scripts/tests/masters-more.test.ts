// A party not kept bill-wise; discount rules on a price list; a voucher
// type's own print format.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/masters-more.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { toPaiseFromSql } from '../../lib/server/money-sql';
import { createInvoice } from '../../lib/server/services/sales';
import { receivePayment } from '../../lib/server/services/payments';
import { bestDiscount, savePriceList } from '../../lib/server/services/price-lists';
import { listVoucherTypes, saveVoucherType } from '../../lib/server/services/voucher-types';

async function withBook(fn: (f: { trx: Trx; orgId: number; branchId: number; bankId: number }) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Masters Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000' }).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, bankId });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test('not bill-wise: a receipt naming no invoices settles the oldest first', async () => {
  await withBook(async ({ trx, orgId, branchId, bankId }) => {
    const customer = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', display_name: 'Running account', state_code: '33', gst_treatment: 'unregistered', bill_wise: 0 } as never).executeTakeFirstOrThrow()).insertId);
    const sell = (date: string, due: string, rupees: number) => createInvoice(trx, orgId, null, {
      branchId, customerId: customer, date, dueDate: due, status: 'approved', lines: [{ description: 'Goods', qty: 1, ratePaise: rupees * 100, gstRatePct: 0 }],
    });
    const later = await sell('2026-06-20', '2026-07-20', 5_000);
    const older = await sell('2026-06-01', '2026-07-01', 3_000);
    await receivePayment(trx, orgId, null, { branchId, contactId: customer, date: '2026-07-05', mode: 'neft', amountPaise: 4_000_00, bankAccountId: bankId });
    const paid = async (id: number) => toPaiseFromSql((await trx.selectFrom('invoices').select('amount_paid').where('id', '=', id).executeTakeFirstOrThrow()).amount_paid);
    assert.equal(await paid(older.id), 3_000_00, 'the oldest due, in full');
    assert.equal(await paid(later.id), 1_000_00, 'the rest on the next');
  });
});

test('discount rules: the best a line qualifies for, unless the line names its own', async () => {
  const rules = [{ itemId: null, minQty: 10, discountPct: 5 }, { itemId: 7, minQty: 50, discountPct: 12 }, { itemId: 7, minQty: 20, discountPct: 8 }];
  assert.equal(bestDiscount(rules, 7, 5), 0);
  assert.equal(bestDiscount(rules, 7, 10), 5, 'the list-wide rule');
  assert.equal(bestDiscount(rules, 7, 25), 8);
  assert.equal(bestDiscount(rules, 7, 60), 12);
  assert.equal(bestDiscount(rules, 9, 60), 5, 'another item has only the list-wide rule');

  await withBook(async ({ trx, orgId, branchId }) => {
    const itemId = Number((await trx.insertInto('items').values({ org_id: orgId, kind: 'goods', name: 'Bolt', uqc: 'NOS', sale_price: '10.0000', gst_rate_pct: 18 }).executeTakeFirstOrThrow()).insertId);
    const list = await savePriceList(trx, orgId, { name: 'Dealers', basis: 'percent', percent: 0, discounts: [{ itemId, minQty: 100, discountPct: 10 }] });
    const customer = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', display_name: 'Dealer', state_code: '33', gst_treatment: 'unregistered', price_list_id: list } as never).executeTakeFirstOrThrow()).insertId);
    const sell = (qty: number, discountPct?: number) => createInvoice(trx, orgId, null, {
      branchId, customerId: customer, date: '2026-06-01', dueDate: '2026-06-01', status: 'draft',
      lines: [{ itemId, qty, ratePaise: 10_00, gstRatePct: 0, discountPct }],
    });
    const taxable = async (id: number) => toPaiseFromSql((await trx.selectFrom('invoices').select('subtotal').where('id', '=', id).executeTakeFirstOrThrow()).subtotal);
    assert.equal(await taxable((await sell(50)).id), 500_00, 'below the break: no discount');
    assert.equal(await taxable((await sell(100)).id), 900_00, '10% off from a hundred');
    assert.equal(await taxable((await sell(100, 2)).id), 980_00, 'a discount named on the line stands');
    await assert.rejects(savePriceList(trx, orgId, { name: 'Bad', basis: 'percent', percent: 0, discounts: [{ itemId: null, minQty: 1, discountPct: 150 }] }), /at most 100%/);
  });
});

test("a voucher type's print format is kept with it", async () => {
  await withBook(async ({ trx, orgId }) => {
    const id = await saveVoucherType(trx, orgId, { docType: 'INV', code: 'EXP', name: 'Export invoice', prefix: 'EXP', printHeading: 'Export invoice', printTerms: 'Payment by wire within 30 days.', printShowUpi: false });
    let [t] = await listVoucherTypes(trx, orgId);
    assert.deepEqual([t.printHeading, t.printTerms, t.printShowUpi, t.printShowBank], ['Export invoice', 'Payment by wire within 30 days.', false, true]);
    await saveVoucherType(trx, orgId, { docType: 'INV', code: 'EXP', name: 'Export invoice', prefix: 'EXP', printShowBank: false }, id);
    [t] = await listVoucherTypes(trx, orgId);
    assert.deepEqual([t.printHeading, t.printShowUpi, t.printShowBank], ['Export invoice', false, false], 'what is not sent stays as it was');
  });
});

test.after(async () => {
  await db.destroy();
});
