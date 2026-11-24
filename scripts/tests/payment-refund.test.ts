// Zoho's Refund on a payment received (services/payments.ts refundPayment):
// money given back from what the receipt left unused. Against real MySQL
// inside rolled-back transactions.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/payment-refund.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { deletePayment, deletePaymentRefund, paymentRefunds, receivePayment, refundPayment, updatePayment } from '../../lib/server/services/payments';
import { toPaiseFromSql } from '../../lib/server/money-sql';

interface Fixture { trx: Trx; orgId: number; branchId: number; acc: Record<string, number>; customerId: number; bankId: number; bankLedger: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Payment Refund Test Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AAACR4849R1ZK' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const customerId = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'customer', display_name: 'Bonita', gst_treatment: 'registered', state_code: '33', pan: 'AAAAA1111A', gstin: '33AAAAA1111A1Z5',
      }).executeTakeFirstOrThrow()).insertId);
      const bankLedger = acc[CODE.BANK_DEFAULT];
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'ICICI', ledger_account_id: bankLedger, opening_balance: '0.0000',
      }).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, acc, customerId, bankId, bankLedger });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

async function balance(trx: Trx, orgId: number, accountId: number): Promise<number> {
  const { rows } = await sql<{ v: string }>`SELECT COALESCE(SUM(debit - credit), 0) AS v FROM journal_lines WHERE org_id = ${orgId} AND account_id = ${accountId}`.execute(trx);
  return toPaiseFromSql(rows[0].v);
}
const unused = async (trx: Trx, id: number) => toPaiseFromSql((await trx.selectFrom('payments').select('unapplied_amount').where('id', '=', id).executeTakeFirstOrThrow()).unapplied_amount);

test.after(() => db.destroy());

const advance = (f: Fixture, amountPaise: number) => receivePayment(f.trx, f.orgId, null, {
  branchId: f.branchId, contactId: f.customerId, date: '2026-10-06', mode: 'neft', amountPaise, bankAccountId: f.bankId, allocations: [],
});

test('a refund gives back part of the unused amount: the customer and the bank are debited and credited, the rest stays unused', async () => {
  await withFixture(async (f) => {
    const { trx, orgId, acc } = f;
    const p = await advance(f, 100_000);
    assert.equal(await balance(trx, orgId, acc[CODE.AR]), -100_000, 'the advance sits as the customer\'s credit');
    const r = await refundPayment(trx, orgId, null, p.id, { date: '2026-10-10', amountPaise: 40_000, mode: 'neft', reference: 'UTR123' });
    assert.equal(r.refundedPaise, 40_000);
    assert.equal(r.unappliedPaise, 60_000);
    assert.equal(await unused(trx, p.id), 60_000);
    assert.equal(await balance(trx, orgId, acc[CODE.AR]), -60_000);
    assert.equal(await balance(trx, orgId, f.bankLedger), 60_000);
    const refunds = await paymentRefunds(trx, orgId, p.id);
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].amountPaise, 40_000);
    assert.equal(refunds[0].date, '2026-10-10');
    await verifyLedgerBalances(trx, orgId);
  });
});

test('more than is unused, nothing unused, an early date or a void payment is refused', async () => {
  await withFixture(async (f) => {
    const { trx, orgId } = f;
    const p = await advance(f, 50_000);
    await assert.rejects(refundPayment(trx, orgId, null, p.id, { date: '2026-10-10', amountPaise: 60_000 }), /Only 500\.00/);
    await assert.rejects(refundPayment(trx, orgId, null, p.id, { date: '2026-10-01', amountPaise: 10_000 }), /before the payment/);
    await refundPayment(trx, orgId, null, p.id, { date: '2026-10-10' });
    assert.equal(await unused(trx, p.id), 0, 'with no amount, all of the unused money is refunded');
    await assert.rejects(refundPayment(trx, orgId, null, p.id, { date: '2026-10-11', amountPaise: 1 }), /nothing to refund/);
  });
});

test('a refunded payment cannot be edited or deleted until the refund is deleted; deleting it reverses it', async () => {
  await withFixture(async (f) => {
    const { trx, orgId, acc } = f;
    const p = await advance(f, 80_000);
    await refundPayment(trx, orgId, null, p.id, { date: '2026-10-10', amountPaise: 30_000 });
    const pay = { branchId: f.branchId, contactId: f.customerId, date: '2026-10-06', mode: 'neft' as const, amountPaise: 90_000, bankAccountId: f.bankId, allocations: [] };
    await assert.rejects(updatePayment(trx, orgId, null, p.id, pay), /has been refunded/);
    await assert.rejects(deletePayment(trx, orgId, null, p.id), /has been refunded/);
    const [r] = await paymentRefunds(trx, orgId, p.id);
    const after = await deletePaymentRefund(trx, orgId, null, p.id, r.entryId);
    assert.equal(after.unappliedPaise, 80_000);
    assert.equal((await paymentRefunds(trx, orgId, p.id)).length, 0);
    assert.equal(await balance(trx, orgId, acc[CODE.AR]), -80_000, 'as if the refund had never been');
    await assert.rejects(deletePaymentRefund(trx, orgId, null, p.id, r.entryId), /does not exist, or was already deleted/);
    await deletePayment(trx, orgId, null, p.id);
    await verifyLedgerBalances(trx, orgId);
  });
});
