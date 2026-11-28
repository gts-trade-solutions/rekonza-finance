// Bulk payment upload (status review 7, item 6): statements and payment files
// as banks really send them (logo rows over the headings, headings over two
// rows, dd/mm/yy dates, amounts with ₹ and commas, Debit/Credit columns or a
// Dr/Cr flag, a byte-order mark); Record Bulk Payments for many bills and
// many invoices at once; the bank's bulk upload file in each layout; and the
// bank's status file read back, paying some transfers and returning others.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/bank-upload.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { readStatementGrid } from '../../lib/bank-statement';
import { findHeader } from '../../lib/imports/header';
import { columnFor } from '../../lib/imports/templates';
import { createBill } from '../../lib/server/services/purchases';
import { createInvoice } from '../../lib/server/services/sales';
import { recordBulkPayments } from '../../lib/server/services/bulk-payments';
import { applyBankReply, batchUploadFile, createBatch, listBatches, submitBatch } from '../../lib/server/services/payment-batches';
import { bankUploadFile, readBankReply } from '../../lib/server/services/bank-upload';
import { seal } from '../../lib/server/crypto/fields';

test('a bank statement with logo rows, a two-row merged heading, dd/mm/yy dates and ₹ amounts reads every line', () => {
  const grid = [
    ['HDFC BANK Ltd.'], [''], ['Account No : 50100123456789', '', 'Statement From : 01/11/26 To : 30/11/26'], ['Branch : Anna Salai'],
    ['Date', 'Narration', 'Chq./Ref.No.', 'Amount', null, 'Closing Balance'],
    [null, null, null, 'Debit', 'Credit', null],
    ['02/11/26', 'NEFT-SRI MURUGAN MOTORS', 'UTR0001', '', '₹1,18,000.00', '1,18,000.00'],
    ['05/11/26', 'RTGS-LAKSHMI AUTO', 'UTR0002', '₹ 59,000.00', '', '59,000.00'],
    ['30/11/26', 'Charges', '', '118.00', '', '58,882.00'],
  ];
  const r = readStatementGrid(grid);
  assert.equal(r.problem, null);
  assert.deepEqual(r.rows.map((x) => [x.date, x.depositPaise, x.withdrawalPaise]), [
    ['2026-11-02', 11_800_000, 0], ['2026-11-05', 0, 5_900_000], ['2026-11-30', 0, 11_800],
  ]);
});

test('one Amount column with a Debit/Credit flag, and a byte-order mark on the first heading', () => {
  const grid = [
    ['﻿Txn Date', 'Description', 'Ref No', 'Amount', 'Debit/Credit', 'Balance'],
    ['01-11-2026', 'UPI receipt', 'U1', '2,500.00', 'C', '2,500.00'],
    ['03-11-2026', 'Rent', 'R1', '1,000.00', 'D', '1,500.00'],
    ['04-11-2026', 'Fees', 'F1', '50.00 Dr', '', '1,450.00'],
  ];
  const r = readStatementGrid(grid);
  assert.deepEqual(r.rows.map((x) => [x.date, x.depositPaise, x.withdrawalPaise]), [
    ['2026-11-01', 250_000, 0], ['2026-11-03', 0, 100_000], ['2026-11-04', 0, 5_000],
  ]);
});

test('a payments file under a bank\'s title rows: its headings are found by the import\'s own column names', () => {
  const grid = [
    ['ICICI Bank Collections Report'], ['Period: 01/11/2026 - 30/11/2026', 'Generated: 01/12/2026'],
    ['Txn Date', 'Remitter Name', 'Credit Amount', 'UTR No', 'Deposit To', 'Invoice Number'],
    ['15/11/2026', 'Buyer', '1,500.00', 'UTR9', 'HDFC Current', 'S-1'],
  ];
  const found = findHeader(grid, (cells) => cells.filter((c) => c && columnFor('payments-received', c)).length)!;
  assert.equal(found.headerAt, 2);
  assert.deepEqual(found.headings.map((h) => columnFor('payments-received', h)), ['date', 'customer', 'amount', 'reference', 'account', 'invoice']);
});

interface Fixture { trx: Trx; orgId: number; branchId: number; userId: number; vendorA: number; vendorB: number; customer: number; bankId: number }
async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Pay Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const userId = Number((await trx.insertInto('users').values({ org_id: orgId, name: 'Priya', email: `p-${orgId}@example.test`, role: 'accountant' } as never).executeTakeFirstOrThrow()).insertId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'HDFC Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000', account_number: '50100123456789' } as never).executeTakeFirstOrThrow()).insertId);
      const vendor = async (name: string, no: string, ifsc: string) => Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'vendor', display_name: name, state_code: '33', gst_treatment: 'unregistered', bank_account_no: seal(no), bank_ifsc: ifsc,
      } as never).executeTakeFirstOrThrow()).insertId);
      const vendorA = await vendor('Lakshmi Auto', '1234567890', 'ICIC0001234');
      const vendorB = await vendor('Brake Works', '9876543210', 'SBIN0004567');
      const customer = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', display_name: 'Buyer', state_code: '33', gst_treatment: 'unregistered' } as never).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, userId, vendorA, vendorB, customer, bankId });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}
const bill = (f: Fixture, vendorId: number, no: string, rupees: number) => createBill(f.trx, f.orgId, null, {
  branchId: f.branchId, vendorId, vendorInvoiceNo: no, date: '2026-11-01', dueDate: '2026-11-30', lines: [{ description: 'Parts', qty: 1, ratePaise: rupees * 100, gstRatePct: 0 }],
});

test('Record Bulk Payments: many bills of two vendors, one payment each with TDS; over the balance refused', async () => {
  await withFixture(async (f) => {
    const a1 = await bill(f, f.vendorA, 'LA-1', 10_000);
    const a2 = await bill(f, f.vendorA, 'LA-2', 5_000);
    const b1 = await bill(f, f.vendorB, 'BW-1', 20_000);
    await assert.rejects(recordBulkPayments(f.trx, f.orgId, f.userId, {
      side: 'made', branchId: f.branchId, date: '2026-11-20', mode: 'neft', bankAccountId: f.bankId,
      rows: [{ docId: a1.id, amountPaise: 1_100_000 }],
    }), /more than the ₹10,000.00 still owed/);
    const made = await recordBulkPayments(f.trx, f.orgId, f.userId, {
      side: 'made', branchId: f.branchId, date: '2026-11-20', mode: 'neft', bankAccountId: f.bankId, reference: 'RUN-11',
      rows: [{ docId: a1.id, amountPaise: 1_000_000 }, { docId: a2.id, amountPaise: 400_000 }, { docId: b1.id, amountPaise: 1_960_000, tdsPaise: 40_000 }],
    });
    assert.deepEqual(made.map((m) => [m.partyName, m.amountPaise, m.tdsPaise, m.documents]).sort(), [['Brake Works', 1_960_000, 40_000, 1], ['Lakshmi Auto', 1_400_000, 0, 2]]);
    const st = await f.trx.selectFrom('bills').select(['internal_no', 'status']).where('org_id', '=', f.orgId).orderBy('id').execute();
    assert.deepEqual(st.map((s) => s.status), ['paid', 'partially_paid', 'paid']);
    // In the bank, for reconciliation: one line per payment.
    const pays = await f.trx.selectFrom('payments').select(['amount', 'bank_account_id', 'reference']).where('org_id', '=', f.orgId).execute();
    assert.equal(pays.length, 2);
    assert.ok(pays.every((p) => p.bank_account_id === f.bankId && p.reference === 'RUN-11'));
    // Receipts: two invoices of one customer, one receipt.
    const i1 = await createInvoice(f.trx, f.orgId, null, { branchId: f.branchId, customerId: f.customer, date: '2026-11-02', dueDate: '2026-11-30', status: 'approved', lines: [{ description: 'Svc', qty: 1, ratePaise: 300_000, gstRatePct: 0 }] });
    const i2 = await createInvoice(f.trx, f.orgId, null, { branchId: f.branchId, customerId: f.customer, date: '2026-11-03', dueDate: '2026-11-30', status: 'approved', lines: [{ description: 'Svc', qty: 1, ratePaise: 200_000, gstRatePct: 0 }] });
    const rec = await recordBulkPayments(f.trx, f.orgId, f.userId, {
      side: 'received', branchId: f.branchId, date: '2026-11-21', mode: 'upi', bankAccountId: f.bankId,
      rows: [{ docId: i1.id, amountPaise: 290_000, tdsPaise: 10_000 }, { docId: i2.id, amountPaise: 200_000 }],
    });
    assert.deepEqual(rec.map((r) => [r.amountPaise, r.tdsPaise, r.documents]), [[490_000, 10_000, 2]]);
  });
});

test('the bank upload file in each layout, and the bank\'s reply: one paid with its UTR, one returned with the reason', async () => {
  await withFixture(async (f) => {
    const a1 = await bill(f, f.vendorA, 'LA-1', 10_000);
    const b1 = await bill(f, f.vendorB, 'BW-1', 250_000);
    const batch = await createBatch(f.trx, f.orgId, f.userId, { branchId: f.branchId, bankAccountId: f.bankId, payDate: '2026-11-25', lines: [{ billId: a1.id, amountPaise: 1_000_000 }, { billId: b1.id, amountPaise: 25_000_000 }] });
    await submitBatch(f.trx, f.orgId, f.userId, batch.id);
    const generic = await batchUploadFile(f.trx, f.orgId, batch.id, 'generic');
    const lines = generic.text.trim().split(/\r\n/);
    assert.equal(lines[0], 'Payment type,Beneficiary name,Beneficiary account no,IFSC,Amount,Value date,Debit account no,Remarks,Bills paid,Customer reference');
    assert.ok(lines.some((l) => l.startsWith('NEFT,Lakshmi Auto,1234567890,ICIC0001234,10000.00,25/11/2026,50100123456789,')));
    assert.ok(lines.some((l) => l.startsWith('RTGS,Brake Works,9876543210,SBIN0004567,250000.00,25/11/2026,')), 'RTGS from ₹2 lakh');
    for (const fmt of ['hdfc', 'icici', 'sbi', 'axis'] as const) {
      const file = await batchUploadFile(f.trx, f.orgId, batch.id, fmt);
      assert.ok(file.text.includes('1234567890') && file.text.includes('10000.00'), fmt);
      assert.equal(file.format.verified, false, `${fmt} is marked as not checked with the bank`);
    }
    const hdfc = await batchUploadFile(f.trx, f.orgId, batch.id, 'hdfc');
    assert.ok(hdfc.text.split('\r\n')[0].startsWith('N,,1234567890,10000.00,Lakshmi Auto,'));
    const sbi = bankUploadFile('sbi', { number: 'PB-1', payDate: '2026-11-25', debitAccountNo: '1' }, [{ vendorId: 1, beneficiary: 'A#B', accountNo: '1', ifsc: 'SBIN0000001', amountPaise: 100, mode: 'NEFT', reference: 'R', remarks: 'x', bills: '' }]);
    assert.ok(!sbi.text.includes('A#B'), 'the separator never appears inside a field');

    const ref = (vendorId: number) => `${batch.number}/${vendorId}`;
    const reply = [
      ['Bulk Payment Status Report'],
      ['Customer Reference No', 'Beneficiary Account', 'Amount', 'Status', 'UTR No', 'Reject Reason'],
      [ref(f.vendorA), '1234567890', '10,000.00', 'Success', 'HDFCN52026112500001', ''],
      [ref(f.vendorB), '9876543210', '2,50,000.00', 'Rejected', '', 'Beneficiary account closed'],
      ['PB/99/1', '1111', '5.00', 'Success', 'X', ''],
    ];
    assert.equal(readBankReply(reply).lines.length, 3);
    const r = await applyBankReply(f.trx, f.orgId, f.userId, batch.id, reply);
    assert.deepEqual(r.paid.map((p) => [p.amountPaise, p.utr]), [[1_000_000, 'HDFCN52026112500001']]);
    assert.deepEqual(r.failed.map((x) => [x.beneficiary, x.reason]), [['Brake Works', 'Beneficiary account closed']]);
    assert.equal(r.unmatched.length, 1);
    const [row] = (await listBatches(f.trx, f.orgId)).filter((b) => b.id === String(batch.id));
    assert.equal(row.status, 'paid');
    assert.deepEqual(row.transfers.map((t) => [t.vendorName, t.bankStatus, t.utr, t.failureReason]).sort(), [
      ['Brake Works', 'failed', null, 'Beneficiary account closed'], ['Lakshmi Auto', 'paid', 'HDFCN52026112500001', null],
    ]);
    const pay = await f.trx.selectFrom('payments').select(['reference', 'amount']).where('org_id', '=', f.orgId).executeTakeFirstOrThrow();
    assert.equal(pay.reference, 'HDFCN52026112500001', 'the UTR is the payment\'s reference, so the statement line matches it');
    const returned = await f.trx.selectFrom('bills').select('status').where('id', '=', b1.id).executeTakeFirstOrThrow();
    assert.notEqual(returned.status, 'paid', 'a returned transfer leaves its bill unpaid');
    // A reply that leaves a transfer out is refused, naming it.
    const again = await createBatch(f.trx, f.orgId, f.userId, { branchId: f.branchId, bankAccountId: f.bankId, payDate: '2026-11-26', lines: [{ billId: b1.id, amountPaise: 25_000_000 }] });
    await submitBatch(f.trx, f.orgId, f.userId, again.id);
    await assert.rejects(applyBankReply(f.trx, f.orgId, f.userId, again.id, [['Reference', 'Status'], ['nothing', 'Success']]), /does not say what happened to 1 transfer/);
  });
});

test.after(() => db.destroy());
