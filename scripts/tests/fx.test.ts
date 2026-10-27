// Foreign currency: documents booked in rupees at their rate, realised gains
// and losses as they are settled at another, advances applied later, and open
// balances restated at a period end and reversed the next day.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/fx.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { applyPayment, makePayment, receivePayment, voidPayment } from '../../lib/server/services/payments';
import { exposure, revalue, setRate } from '../../lib/server/services/fx';
import { toPaiseFromSql } from '../../lib/server/money-sql';

const R = (rupees: number) => Math.round(rupees * 100);
const USD = (dollars: number) => Math.round(dollars * 100);
interface Fixture { trx: Trx; orgId: number; branchId: number; bankId: number; acc: Record<string, number>; buyer: number; seller: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Exporter' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', gstin: '33AAACE1234E1Z1', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '8708', kind: 'hsn', description: 'Parts', gst_rate_pct: 18, is_active: 1 }).execute();
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
      }).executeTakeFirstOrThrow()).insertId);
      const contact = async (v: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, state_code: '96', gst_treatment: 'overseas', currency: 'USD', ...v } as never).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId, bankId, acc,
        buyer: await contact({ kind: 'customer', display_name: 'Detroit Motors' }),
        seller: await contact({ kind: 'vendor', display_name: 'Ohio Tools' }),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const balance = async (f: Fixture, code: string, upTo = '2099-12-31') => toPaiseFromSql((await sql<{ b: string }>`
  SELECT COALESCE(SUM(debit - credit), 0) AS b FROM journal_lines WHERE account_id = ${f.acc[code]} AND entry_date <= ${upTo}
`.execute(f.trx)).rows[0].b);
const exportInvoice = (f: Fixture, date: string, dollars: number, rate: number) => createInvoice(f.trx, f.orgId, null, {
  branchId: f.branchId, customerId: f.buyer, date, dueDate: date, status: 'approved', currency: 'USD', exchangeRate: rate,
  lines: [{ description: 'Brake discs', hsnSac: '8708', qty: 1, ratePaise: USD(dollars), gstRatePct: 18 }],
});
const invoiceRow = (f: Fixture, id: number) => f.trx.selectFrom('invoices')
  .select(['currency', 'exchange_rate', 'fc_total', 'fc_amount_paid', 'total', 'amount_paid', 'status']).where('id', '=', id).executeTakeFirstOrThrow();

test('an export in dollars, paid in two parts at other rates: realised gain and loss', async () => {
  await withFixture(async (f) => {
    const inv = await exportInvoice(f, '2026-06-01', 1_000, 83);
    let row = await invoiceRow(f, inv.id);
    assert.equal(row.currency, 'USD');
    assert.deepEqual([toPaiseFromSql(row.fc_total!), toPaiseFromSql(row.total)], [USD(1_000), R(83_000)], 'booked in rupees at 83');

    // $400 at 84.50: worth ₹33,800 in the bank, ₹33,200 off the receivable.
    const part = await receivePayment(f.trx, f.orgId, null, {
      branchId: f.branchId, contactId: f.buyer, date: '2026-06-20', mode: 'neft', amountPaise: R(33_800), bankAccountId: f.bankId,
      fx: { currency: 'USD', rate: 84.5, foreignAmountPaise: USD(400) },
      allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: 0, foreignAmountPaise: USD(400) }],
    });
    row = await invoiceRow(f, inv.id);
    assert.deepEqual([toPaiseFromSql(row.fc_amount_paid), toPaiseFromSql(row.amount_paid)], [USD(400), R(33_200)]);
    assert.equal(await balance(f, CODE.FX_GAIN), -R(600));

    // The rest, $600 at 82: ₹49,200 clears the ₹49,800 still carried, a ₹600 loss.
    await receivePayment(f.trx, f.orgId, null, {
      branchId: f.branchId, contactId: f.buyer, date: '2026-07-10', mode: 'neft', amountPaise: R(49_200), bankAccountId: f.bankId,
      fx: { currency: 'USD', rate: 82, foreignAmountPaise: USD(600) },
      allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: 0, foreignAmountPaise: USD(600) }],
    });
    row = await invoiceRow(f, inv.id);
    assert.equal(row.status, 'paid');
    assert.equal(toPaiseFromSql(row.amount_paid), R(83_000), 'settled to the paisa');
    assert.equal(await balance(f, CODE.FX_LOSS), R(600));
    assert.equal(await balance(f, CODE.AR), 0);
    assert.equal(await balance(f, CODE.BANK_DEFAULT), R(83_000));

    await assert.rejects(receivePayment(f.trx, f.orgId, null, {
      branchId: f.branchId, contactId: f.buyer, date: '2026-07-11', mode: 'neft', amountPaise: R(100), bankAccountId: f.bankId,
      fx: { currency: 'USD', rate: 82, foreignAmountPaise: USD(1) },
      allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: 0, foreignAmountPaise: USD(1) }],
    }), /still owed/);

    await voidPayment(f.trx, f.orgId, null, part.id, 'Entered against the wrong invoice');
    row = await invoiceRow(f, inv.id);
    assert.equal(toPaiseFromSql(row.fc_amount_paid), USD(600), 'the void gives the dollars back too');
  });
});

test('an advance in dollars applied to a later invoice at a different rate', async () => {
  await withFixture(async (f) => {
    const adv = await receivePayment(f.trx, f.orgId, null, {
      branchId: f.branchId, contactId: f.buyer, date: '2026-05-01', mode: 'neft', amountPaise: R(41_500), bankAccountId: f.bankId,
      fx: { currency: 'USD', rate: 83, foreignAmountPaise: USD(500) },
    });
    assert.equal(adv.unappliedPaise, R(41_500));
    const inv = await exportInvoice(f, '2026-06-01', 500, 84);
    await applyPayment(f.trx, f.orgId, null, adv.id, {
      date: '2026-06-01', allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: 0, foreignAmountPaise: USD(500) }],
    });
    assert.equal((await invoiceRow(f, inv.id)).status, 'paid');
    assert.equal(await balance(f, CODE.FX_LOSS), R(500), 'the advance came in at 83; the sale was booked at 84');
    assert.equal(await balance(f, CODE.AR), 0, 'the customer owes nothing');
  });
});

test('an import paid at a dearer rate, and open balances restated at the period end', async () => {
  await withFixture(async (f) => {
    const bill = await createBill(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.seller, vendorInvoiceNo: 'OT-9', date: '2026-06-05', dueDate: '2026-07-05', status: 'open',
      currency: 'USD', exchangeRate: 83, lines: [{ description: 'Gauges', qty: 1, ratePaise: USD(200), gstRatePct: 0 }],
    } as never);
    await exportInvoice(f, '2026-06-01', 1_000, 83);

    await assert.rejects(revalue(f.trx, f.orgId, null, '2026-06-30'), /closing rate for USD/);
    await setRate(f.trx, f.orgId, { currency: 'USD', date: '2026-06-30', rate: 84 });
    const rows = await exposure(f.trx, f.orgId, '2026-06-30');
    assert.deepEqual(rows.map((r) => [r.kind, r.differencePaise]).sort(), [['bill', R(200)], ['invoice', R(1_000)]]);
    const r = await revalue(f.trx, f.orgId, null, '2026-06-30');
    assert.equal(r.netPaise, R(800), '₹1,000 more receivable, ₹200 more payable');
    assert.equal(await balance(f, CODE.FX_GAIN, '2026-06-30'), -R(800), 'in the June accounts');
    assert.equal(await balance(f, CODE.FX_GAIN), 0, 'reversed on 1 July');
    await assert.rejects(revalue(f.trx, f.orgId, null, '2026-06-30'), /already restated/);

    await makePayment(f.trx, f.orgId, null, {
      branchId: f.branchId, contactId: f.seller, date: '2026-07-05', mode: 'neft', amountPaise: R(16_800), bankAccountId: f.bankId,
      fx: { currency: 'USD', rate: 84, foreignAmountPaise: USD(200) },
      allocations: [{ targetType: 'bill', targetId: bill.id, amountPaise: 0, foreignAmountPaise: USD(200) }],
    });
    assert.equal(await balance(f, CODE.FX_LOSS), R(200), 'paid ₹16,800 for what was booked at ₹16,600');
    assert.equal(await balance(f, CODE.AP), 0);
  });
});

test.after(async () => {
  await db.destroy();
});
