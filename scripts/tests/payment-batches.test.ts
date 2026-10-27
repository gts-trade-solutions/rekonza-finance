// Payment batches: choose, release (with a checker where a rule asks), bank file, paid.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/payment-batches.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { createBill } from '../../lib/server/services/purchases';
import { pendingApprovals, saveRule } from '../../lib/server/services/approvals';
import {
  approveBatch, bankFile, cancelBatch, createBatch, listBatches, markBatchPaid, payableBills, rejectBatch, submitBatch,
} from '../../lib/server/services/payment-batches';

interface Fixture { trx: Trx; orgId: number; branchId: number; bankId: number; small: number; big: number; nobank: number; maker: number; checker: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Batch Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const vendor = async (name: string, bank: Record<string, unknown>) => Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'vendor', display_name: name, state_code: '33', gst_treatment: 'unregistered', ...bank,
      } as never).executeTakeFirstOrThrow()).insertId);
      const user = async (name: string, role: 'admin' | 'accountant') =>
        Number((await trx.insertInto('users').values({ org_id: orgId, name, email: `${name}-${orgId}@example.test`, role }).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId,
        bankId: Number((await trx.insertInto('bank_accounts').values({
          org_id: orgId, kind: 'bank', name: 'Current account', account_number: '50200012345678', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
        }).executeTakeFirstOrThrow()).insertId),
        small: await vendor('Small Supplier', { bank_account_no: '1234 5678 9012', bank_ifsc: 'hdfc0001234', bank_account_name: 'Small Supplier Pvt Ltd' }),
        big: await vendor('Big Supplier', { bank_account_no: '99887766', bank_ifsc: 'ICIC0000999' }),
        nobank: await vendor('No Bank Supplier', {}),
        maker: await user('maker', 'accountant'),
        checker: await user('checker', 'admin'),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

let n = 0;
const bill = async (f: Fixture, vendorId: number, rupees: number, due = '2026-08-31') => (await createBill(f.trx, f.orgId, f.maker, {
  branchId: f.branchId, vendorId, vendorInvoiceNo: `S-${++n}`, date: '2026-08-01', dueDate: due, status: 'open',
  lines: [{ description: 'Stock', qty: 1, ratePaise: rupees * 100, gstRatePct: 0 }],
})).id;

test('with no rule a batch releases at once; the file has one transfer per supplier; paying settles every bill', async () => {
  await withFixture(async (f) => {
    const a1 = await bill(f, f.small, 40_000), a2 = await bill(f, f.small, 25_000), b1 = await bill(f, f.big, 3_00_000, '2026-09-30');
    assert.deepEqual((await payableBills(f.trx, f.orgId, { dueBy: '2026-08-31' })).map((b) => b.id).sort(), [a1, a2].map(String).sort());

    const made = await createBatch(f.trx, f.orgId, f.maker, {
      branchId: f.branchId, bankAccountId: f.bankId, payDate: '2026-09-05',
      lines: [{ billId: a1, amountPaise: 40_000_00 }, { billId: a2, amountPaise: 10_000_00 }, { billId: b1, amountPaise: 3_00_000_00 }],
    });
    assert.match(made.number, /^PB/);
    await assert.rejects(createBatch(f.trx, f.orgId, f.maker, { branchId: f.branchId, bankAccountId: f.bankId, payDate: '2026-09-05', lines: [{ billId: a1, amountPaise: 1_00 }] }), /already in batch/);
    await assert.rejects(bankFile(f.trx, f.orgId, made.id), /not been released/);

    assert.equal((await submitBatch(f.trx, f.orgId, f.maker, made.id)).status, 'approved');
    const file = await bankFile(f.trx, f.orgId, made.id);
    assert.deepEqual(file.rows.map((r) => [r[0], r[2], r[3], r[4], r[5], r[6]]), [
      ['NEFT', '123456789012', 'HDFC0001234', '50000.00', '05/09/2026', '50200012345678'],
      ['RTGS', '99887766', 'ICIC0000999', '300000.00', '05/09/2026', '50200012345678'],
    ]);
    assert.equal(file.rows[0][1], 'Small Supplier Pvt Ltd', 'the account name, where the supplier gave one');
    assert.ok(String(file.rows[0][7]).length <= 30);

    const paid = await markBatchPaid(f.trx, f.orgId, f.maker, made.id, { references: { [String(f.big)]: 'UTR123' } });
    assert.equal(paid.length, 2);
    const bills = await f.trx.selectFrom('bills').select(['id', 'status', 'amount_paid']).where('id', 'in', [a1, a2, b1]).orderBy('id').execute();
    assert.deepEqual(bills.map((b) => [b.status, Number(b.amount_paid)]), [['paid', 40000], ['partially_paid', 10000], ['paid', 300000]]);
    const pay = await f.trx.selectFrom('payments').select(['mode', 'reference']).where('contact_id', '=', f.big).executeTakeFirstOrThrow();
    assert.deepEqual([pay.mode, pay.reference], ['rtgs', 'UTR123']);
    assert.equal((await listBatches(f.trx, f.orgId))[0].status, 'paid');
    assert.ok((await verifyLedgerBalances(f.trx, f.orgId)).balanced);
  });
});

test('a rule holds the batch for a second person; a supplier without bank details stops the release', async () => {
  await withFixture(async (f) => {
    await saveRule(f.trx, f.orgId, { documentType: 'payment_batch', thresholdPaise: 1_00_000_00, approverRole: 'admin', isActive: true });
    const x = await bill(f, f.nobank, 1_50_000);
    const blocked = await createBatch(f.trx, f.orgId, f.maker, { branchId: f.branchId, bankAccountId: f.bankId, payDate: '2026-09-05', lines: [{ billId: x, amountPaise: 1_50_000_00 }] });
    await assert.rejects(submitBatch(f.trx, f.orgId, f.maker, blocked.id), /No usable bank account and IFSC for No Bank Supplier/);
    await cancelBatch(f.trx, f.orgId, blocked.id);

    const y = await bill(f, f.big, 2_50_000);
    const batch = await createBatch(f.trx, f.orgId, f.maker, { branchId: f.branchId, bankAccountId: f.bankId, payDate: '2026-09-05', lines: [{ billId: y, amountPaise: 2_50_000_00 }] });
    assert.equal((await submitBatch(f.trx, f.orgId, f.maker, batch.id)).status, 'pending');
    assert.deepEqual((await pendingApprovals(f.trx, f.orgId)).map((p) => [p.documentType, p.partyName]), [['payment_batch', '1 supplier']]);
    await assert.rejects(approveBatch(f.trx, f.orgId, { userId: f.maker, role: 'admin' }, batch.id), /Someone else/);
    await rejectBatch(f.trx, f.orgId, { userId: f.checker, role: 'admin' }, batch.id, 'Pay on the 10th');
    assert.equal((await submitBatch(f.trx, f.orgId, f.maker, batch.id)).status, 'pending', 'sent back, it can go again');

    // Edited after submission: the file still pays the account the approver saw.
    await approveBatch(f.trx, f.orgId, { userId: f.checker, role: 'admin' }, batch.id);
    await f.trx.updateTable('contacts').set({ bank_account_no: '000111' }).where('id', '=', f.big).execute();
    assert.equal((await bankFile(f.trx, f.orgId, batch.id)).rows[0][2], '99887766');

    // A transfer the bank returned leaves its bills unpaid and free for the next batch.
    await assert.rejects(markBatchPaid(f.trx, f.orgId, f.maker, batch.id, { failedVendorIds: [f.big] }), /cancel the batch/);
    assert.equal((await payableBills(f.trx, f.orgId)).find((b) => b.id === String(y))?.inBatch, batch.number);
  });
});

test.after(async () => {
  await db.destroy();
});
