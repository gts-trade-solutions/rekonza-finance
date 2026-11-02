// Statements of account: the opening balance from before the period, every
// document and payment in it, a void that happened inside the period left out,
// and a closing balance that equals the ledger's.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/statements.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice, voidInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { makePayment, receivePayment } from '../../lib/server/services/payments';
import { partyStatement } from '../../lib/server/reports/party-statement';
import { hasPermission } from '../../lib/rbac';

async function withBook(fn: (f: { trx: Trx; orgId: number; branchId: number; customer: number; vendor: number; bankId: number }) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Statement Co', address: '12 Anna Salai, Chennai' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33ABCDE1234F1Z5' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const contact = (kind: string, name: string) => trx.insertInto('contacts')
        .values({ org_id: orgId, kind, display_name: name, state_code: '33', gst_treatment: 'unregistered' } as never)
        .executeTakeFirstOrThrow().then((r) => Number(r.insertId));
      const customer = await contact('customer', 'Kumar Stores');
      const vendor = await contact('vendor', 'Steel Supply');
      const bankId = Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000' }).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, customer, vendor, bankId });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test('a customer statement: opening, invoices and receipts, a void inside the period left out', async () => {
  await withBook(async ({ trx, orgId, branchId, customer, bankId }) => {
    const sell = (date: string, rupees: number) => createInvoice(trx, orgId, null, {
      branchId, customerId: customer, date, dueDate: date, status: 'approved',
      lines: [{ description: 'Goods', qty: 1, ratePaise: rupees * 100, gstRatePct: 0 }],
    });
    const march = await sell('2026-03-10', 1_000); // before the period: the opening balance
    const april = await sell('2026-04-05', 2_500);
    await receivePayment(trx, orgId, null, {
      branchId, contactId: customer, date: '2026-04-20', mode: 'neft', amountPaise: 1_500_00, bankAccountId: bankId,
      allocations: [{ targetType: 'invoice', targetId: march.id, amountPaise: 1_000_00 }, { targetType: 'invoice', targetId: april.id, amountPaise: 500_00 }],
    });
    const mistake = await sell('2026-04-25', 700);
    await voidInvoice(trx, orgId, null, mistake.id, 'Raised twice');

    const s = await partyStatement(trx, orgId, customer, 'customer', '2026-04-01', '2026-04-30');
    assert.equal(s.openingPaise, 1_000_00, 'March is owed at the start of April');
    assert.deepEqual(s.lines.map((l) => [l.kind, l.chargePaise, l.paymentPaise, l.balancePaise]), [
      ['Invoice', 2_500_00, 0, 3_500_00],
      ['Payment received', 0, 1_500_00, 2_000_00],
    ], 'the voided invoice and its reversal, both in April, do not appear');
    assert.equal(s.closingPaise, 2_000_00);
    assert.equal(s.chargesPaise, 2_500_00);
    assert.equal(s.paymentsPaise, 1_500_00);
    assert.match(s.lines[0].number, /\S/, 'the invoice is shown by its own number');
    assert.match(s.lines[0].detail ?? '', /^Due 2026-04-05/);
    assert.equal(s.org.gstin, '33ABCDE1234F1Z5');

    // The closing balance is the ledger's: the receivable account for this customer at the end of April.
    const { closingPaise } = await partyStatement(trx, orgId, customer, 'customer', '2026-01-01', '2026-04-30');
    assert.equal(closingPaise, s.closingPaise, 'the same balance whatever period it is read from');

    // Voided after the period opened, the void shows: the opening counted the original.
    const may = await partyStatement(trx, orgId, customer, 'customer', '2026-04-26', '2026-05-31');
    assert.equal(may.lines.length, 0, 'nothing in the period');
    assert.equal(may.openingPaise, 2_000_00);
  });
});

test('a vendor statement reads the payable side: bills raise it, payments bring it down', async () => {
  await withBook(async ({ trx, orgId, branchId, vendor, bankId }) => {
    const acc = await accountIds(trx, orgId);
    const bill = await createBill(trx, orgId, null, {
      branchId, vendorId: vendor, vendorInvoiceNo: 'SS/118', date: '2026-04-03', dueDate: '2026-05-03',
      lines: [{ accountId: acc[CODE.OFFICE], description: 'Steel', qty: 1, ratePaise: 4_000_00, gstRatePct: 0 }],
    });
    await makePayment(trx, orgId, null, {
      branchId, contactId: vendor, date: '2026-04-15', mode: 'neft', amountPaise: 3_000_00, bankAccountId: bankId,
      allocations: [{ targetType: 'bill', targetId: bill.id, amountPaise: 3_000_00 }],
    });
    const s = await partyStatement(trx, orgId, vendor, 'vendor', '2026-04-01', '2026-04-30');
    assert.deepEqual(s.lines.map((l) => [l.kind, l.chargePaise, l.paymentPaise, l.balancePaise]), [
      ['Bill', 4_000_00, 0, 4_000_00],
      ['Payment made', 0, 3_000_00, 1_000_00],
    ]);
    assert.equal(s.lines[0].detail, 'Their no. SS/118');
    assert.equal(s.closingPaise, 1_000_00);
    // The customer side of the same contact has nothing on it.
    assert.equal((await partyStatement(trx, orgId, vendor, 'customer', '2026-04-01', '2026-04-30')).lines.length, 0);
  });
});

test('a sales role cannot read purchasing\'s side', () => {
  assert.equal(hasPermission('sales', 'purchases', 'view'), false, 'so the contact page sends a sales role no bills');
  assert.equal(hasPermission('sales', 'sales', 'view'), true);
});

test.after(() => db.destroy());
