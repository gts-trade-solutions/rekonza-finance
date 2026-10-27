// Opening balances: ledger figures, customers' and vendors' old bills, and
// how they age and get paid.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/opening-balances.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { receivePayment } from '../../lib/server/services/payments';
import {
  addOpeningDocument, openingSummary, setAccountOpenings, setBooksStartDate, voidOpeningDocument,
} from '../../lib/server/services/opening-balances';
import { ageing, balanceSheet } from '../../lib/server/reports/statements';

interface Fixture { trx: Trx; orgId: number; branchId: number; bankId: number; acc: Record<string, number>; customer: number; vendor: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Openings Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({
        org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1,
      }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const mk = async (values: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, state_code: '33', gst_treatment: 'unregistered', ...values } as never).executeTakeFirstOrThrow()).insertId);
      // The receiving account has a ledger of its own, so the cash-at-bank
      // opening below is a plain ledger figure.
      const ledger = Number((await trx.insertInto('accounts').values({
        org_id: orgId, code: '1215', name: 'Receipts account', type: 'asset', subtype: 'bank',
      }).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId, acc,
        bankId: Number((await trx.insertInto('bank_accounts').values({
          org_id: orgId, kind: 'bank', name: 'Receipts', ledger_account_id: ledger, opening_balance: '0.0000',
        }).executeTakeFirstOrThrow()).insertId),
        customer: await mk({ kind: 'customer', display_name: 'Old Customer' }),
        vendor: await mk({ kind: 'vendor', display_name: 'Old Supplier' }),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test('the openings agree when 3300 holds exactly the opening stock', async () => {
  await withFixture(async (f) => {
    await setBooksStartDate(f.trx, f.orgId, '2026-04-01');
    await f.trx.insertInto('items').values({
      org_id: f.orgId, kind: 'goods', name: 'Pad', uqc: 'NOS', sale_price: '100.0000', purchase_price: '50.0000',
      gst_rate_pct: 18, track_inventory: 1, opening_stock_qty: '10', opening_stock_rate: '5000.0000',
    }).execute();

    await setAccountOpenings(f.trx, f.orgId, null, {
      branchId: f.branchId,
      lines: [
        { accountId: f.acc[CODE.BANK_DEFAULT], netPaise: 3_00_000_00 },
        { accountId: f.acc[CODE.CAPITAL], netPaise: -5_00_000_00 },
      ],
    });
    await addOpeningDocument(f.trx, f.orgId, null, {
      branchId: f.branchId, contactId: f.customer, kind: 'receivable', refNo: 'OLD/101',
      docDate: '2026-02-10', dueDate: '2026-03-12', amountPaise: 1_50_000_00,
    });

    const s = await openingSummary(f.trx, f.orgId);
    assert.equal(s.receivablesPaise, 1_50_000_00);
    assert.equal(s.stockPaise, 50_000_00);
    assert.equal(s.equityBalancePaise, 50_000_00, 'debit: the stock, which has no ledger of its own');
    assert.equal(s.differencePaise, 0);

    const bs = await balanceSheet(f.trx, f.orgId, '2026-04-01');
    assert.ok(bs.balanced);

    // A change posts the difference, never an edit.
    const r = await setAccountOpenings(f.trx, f.orgId, null, {
      branchId: f.branchId, lines: [{ accountId: f.acc[CODE.BANK_DEFAULT], netPaise: 3_50_000_00 }],
    });
    assert.equal(r.changed, 1);
    assert.equal((await openingSummary(f.trx, f.orgId)).differencePaise, -50_000_00, '50,000 more debit than credit');
  });
});

test('openings that come from elsewhere are refused as ledger figures', async () => {
  await withFixture(async (f) => {
    await assert.rejects(
      setAccountOpenings(f.trx, f.orgId, null, { branchId: f.branchId, lines: [{ accountId: f.acc[CODE.AR], netPaise: 100 }] }),
      /customer by customer/,
    );
    const bankLedger = (await f.trx.selectFrom('bank_accounts').select('ledger_account_id').where('id', '=', f.bankId).executeTakeFirstOrThrow()).ledger_account_id;
    await assert.rejects(
      setAccountOpenings(f.trx, f.orgId, null, { branchId: f.branchId, lines: [{ accountId: bankLedger, netPaise: 100 }] }),
      /set on the account in Banking/,
    );
  });
});

test('an opening bill is one from before the books start; once posted, the date is fixed', async () => {
  await withFixture(async (f) => {
    await setBooksStartDate(f.trx, f.orgId, '2026-04-01');
    await assert.rejects(
      addOpeningDocument(f.trx, f.orgId, null, {
        branchId: f.branchId, contactId: f.vendor, kind: 'payable', refNo: 'NEW-1',
        docDate: '2026-04-05', dueDate: '2026-05-05', amountPaise: 100_00,
      }),
      /before the books start/,
    );
    await addOpeningDocument(f.trx, f.orgId, null, {
      branchId: f.branchId, contactId: f.vendor, kind: 'payable', refNo: 'S-77',
      docDate: '2026-03-01', dueDate: '2026-03-31', amountPaise: 40_000_00,
    });
    await assert.rejects(setBooksStartDate(f.trx, f.orgId, '2026-05-01'), /already posted/);
  });
});

test('a receipt settles an opening bill, which then stops ageing', async () => {
  await withFixture(async (f) => {
    await setBooksStartDate(f.trx, f.orgId, '2026-04-01');
    const old = await addOpeningDocument(f.trx, f.orgId, null, {
      branchId: f.branchId, contactId: f.customer, kind: 'receivable', refNo: 'OLD/7',
      docDate: '2026-01-15', dueDate: '2026-02-14', amountPaise: 20_000_00,
    });
    let a = await ageing(f.trx, f.orgId, 'receivable', '2026-05-31');
    assert.equal(a.rows[0].buckets['60+'], 20_000_00, 'due 14 February, aged from then');

    await receivePayment(f.trx, f.orgId, null, {
      branchId: f.branchId, contactId: f.customer, date: '2026-06-01', mode: 'neft',
      amountPaise: 20_000_00, bankAccountId: f.bankId,
      allocations: [{ targetType: 'opening', targetId: old.id, amountPaise: 20_000_00 }],
    });
    const d = await f.trx.selectFrom('opening_documents').select(['status']).where('id', '=', old.id).executeTakeFirstOrThrow();
    assert.equal(d.status, 'paid');
    a = await ageing(f.trx, f.orgId, 'receivable', '2026-06-30');
    assert.equal(a.rows.length, 0, 'nothing owed');

    await assert.rejects(voidOpeningDocument(f.trx, f.orgId, null, old.id), /paid against/);
  });
});

test('ageing lays what is owed against the newest bills', async () => {
  await withFixture(async (f) => {
    const sell = (date: string, due: string) => createInvoice(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customer, date, dueDate: due, status: 'approved',
      lines: [{ description: 'Goods', qty: 1, ratePaise: 1_000_00, gstRatePct: 0 }],
    });
    await sell('2026-04-01', '2026-05-01');
    await sell('2026-06-01', '2026-07-01');
    // One payment, applied to nothing: it clears the oldest by convention.
    await receivePayment(f.trx, f.orgId, null, {
      branchId: f.branchId, contactId: f.customer, date: '2026-06-15', mode: 'neft', amountPaise: 1_000_00, bankAccountId: f.bankId,
    });
    const a = await ageing(f.trx, f.orgId, 'receivable', '2026-07-20');
    assert.equal(a.rows[0].totalPaise, 1_000_00);
    assert.equal(a.rows[0].buckets['16–30'], 1_000_00, 'the July bill, 19 days late');
    assert.equal(a.rows[0].buckets['60+'], 0, 'not the May bill, which was paid');
  });
});

test.after(async () => {
  await db.destroy();
});
