// Cheques: linking a cheque to the payment it made, and what a return undoes.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/cheques.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { createInvoice } from '../../lib/server/services/sales';
import { receivePayment, makePayment, voidPayment } from '../../lib/server/services/payments';
import { clearCheque, moveCheque, returnCheque, noticeDeadline } from '../../lib/server/services/cheques';
import { toSqlFromPaise } from '../../lib/server/money-sql';

interface Fixture {
  trx: Trx; orgId: number; branchId: number; bankId: number; bankLedger: number;
  acc: Record<string, number>; customer: number; vendor: number;
}

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Cheques Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({
        org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1,
      }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const mk = async (values: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, state_code: '33', gst_treatment: 'unregistered', ...values } as never).executeTakeFirstOrThrow()).insertId);
      const bankLedger = acc[CODE.BANK_DEFAULT];
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'Current account', ledger_account_id: bankLedger, opening_balance: '0.0000',
      }).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId, acc, bankId, bankLedger,
        customer: await mk({ kind: 'customer', display_name: 'Sharma Traders' }),
        vendor: await mk({ kind: 'vendor', display_name: 'Steel Supplier' }),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

async function registerCheque(f: Fixture, kind: 'received' | 'issued', contactId: number, chequeNo: string, amountPaise: number) {
  return Number((await f.trx.insertInto('cheques').values({
    org_id: f.orgId, kind, contact_id: contactId, cheque_no: chequeNo, amount: toSqlFromPaise(amountPaise),
    maturity_date: '2026-06-01', status: 'in_hand',
  }).executeTakeFirstOrThrow()).insertId);
}

async function balance(f: Fixture, accountId: number, contactId?: number) {
  const { rows } = await sql<{ v: string }>`
    SELECT COALESCE(SUM(debit - credit), 0) AS v FROM journal_lines
     WHERE org_id = ${f.orgId} AND account_id = ${accountId}
       ${contactId ? sql`AND contact_id = ${contactId}` : sql``}
  `.execute(f.trx);
  return Math.round(Number(rows[0].v) * 100);
}

async function sale(f: Fixture, amountPaise: number) {
  return createInvoice(f.trx, f.orgId, null, {
    branchId: f.branchId, customerId: f.customer, date: '2026-05-01', dueDate: '2026-05-31', status: 'approved',
    lines: [{ description: 'Goods', qty: 1, ratePaise: amountPaise, gstRatePct: 0 }],
  });
}

test('a receipt entered with the cheque number links itself; a return reopens the invoice', async () => {
  await withFixture(async (f) => {
    const inv = await sale(f, 50_000_00);
    const chq = await registerCheque(f, 'received', f.customer, '004512', 50_000_00);
    const rcpt = await receivePayment(f.trx, f.orgId, null, {
      branchId: f.branchId, contactId: f.customer, date: '2026-06-02', mode: 'cheque', reference: '004512',
      amountPaise: 50_000_00, bankAccountId: f.bankId,
      allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: 50_000_00 }],
    });
    const linked = await f.trx.selectFrom('cheques').select('payment_id').where('id', '=', chq).executeTakeFirstOrThrow();
    assert.equal(linked.payment_id, rcpt.id);

    await clearCheque(f.trx, f.orgId, chq, { date: '2026-06-03' });
    assert.equal((await f.trx.selectFrom('invoices').select('status').where('id', '=', inv.id).executeTakeFirstOrThrow()).status, 'paid');

    const r = await returnCheque(f.trx, f.orgId, null, chq, {
      date: '2026-06-06', reason: 'Funds insufficient', chargesPaise: 590_00, chargeToParty: true, branchId: f.branchId,
    });
    assert.equal(r.reversedPayment, rcpt.number);

    const invAfter = await f.trx.selectFrom('invoices').select(['status', 'amount_paid']).where('id', '=', inv.id).executeTakeFirstOrThrow();
    assert.equal(invAfter.status, 'sent', 'owed again');
    assert.equal(Number(invAfter.amount_paid), 0);
    assert.equal((await f.trx.selectFrom('payments').select('status').where('id', '=', rcpt.id).executeTakeFirstOrThrow()).status, 'void');

    // The customer owes the invoice again plus the charge; the bank is down by the charge only.
    assert.equal(await balance(f, f.acc[CODE.AR], f.customer), 50_000_00 + 590_00);
    assert.equal(await balance(f, f.bankLedger), -590_00);
    assert.equal(await balance(f, f.acc[CODE.BANK_CHARGES]), 0);

    // The reversal sits on the return date, not the receipt's.
    const rev = await f.trx.selectFrom('journal_entries').select('entry_date')
      .where('org_id', '=', f.orgId).where('reversal_of_entry_id', '=', rcpt.journalEntryId).executeTakeFirstOrThrow();
    assert.equal(String(rev.entry_date).slice(0, 10), '2026-06-06');

    assert.ok((await verifyLedgerBalances(f.trx, f.orgId)).balanced);
    await assert.rejects(returnCheque(f.trx, f.orgId, null, chq, { date: '2026-06-07', reason: 'again', branchId: f.branchId }), /already/);
  });
});

test('clearing finds the payment entered before the cheque was registered', async () => {
  await withFixture(async (f) => {
    const pay = await makePayment(f.trx, f.orgId, null, {
      branchId: f.branchId, contactId: f.vendor, date: '2026-06-01', mode: 'cheque', reference: '771203',
      amountPaise: 12_000_00, bankAccountId: f.bankId,
    });
    const chq = await registerCheque(f, 'issued', f.vendor, '771203', 12_000_00);
    const r = await clearCheque(f.trx, f.orgId, chq, { date: '2026-06-04' });
    assert.equal(r.paymentNumber, pay.number);

    // Our own cheque came back: the payment is undone and the bank's charge is ours.
    await returnCheque(f.trx, f.orgId, null, chq, { date: '2026-06-05', reason: 'Exceeds arrangement', chargesPaise: 300_00, branchId: f.branchId });
    assert.equal(await balance(f, f.acc[CODE.AP], f.vendor), 0, 'the payment no longer settles anything');
    assert.equal(await balance(f, f.acc[CODE.BANK_CHARGES]), 300_00);
    await assert.rejects(
      returnCheque(f.trx, f.orgId, null, await registerCheque(f, 'issued', f.vendor, '771204', 1_00), {
        date: '2026-06-05', reason: 'x', chargesPaise: 0, chargeToParty: true, branchId: f.branchId,
      }),
      /Only a customer/,
    );
  });
});

test('a return with nothing linked posts only the charge, and needs the account it came from', async () => {
  await withFixture(async (f) => {
    const chq = await registerCheque(f, 'received', f.customer, '100001', 5_000_00);
    await moveCheque(f.trx, f.orgId, chq, 'deposited');
    await assert.rejects(
      returnCheque(f.trx, f.orgId, null, chq, { date: '2026-06-03', reason: 'Signature differs', chargesPaise: 100_00, branchId: f.branchId }),
      /which bank account/,
    );
    const r = await returnCheque(f.trx, f.orgId, null, chq, {
      date: '2026-06-03', reason: 'Signature differs', chargesPaise: 100_00, bankAccountId: f.bankId, branchId: f.branchId,
    });
    assert.equal(r.reversedPayment, null);
    assert.equal(await balance(f, f.acc[CODE.BANK_CHARGES]), 100_00);
  });
});

test('a cheque that paid something cannot simply be cancelled; a voided payment frees it', async () => {
  await withFixture(async (f) => {
    const chq = await registerCheque(f, 'received', f.customer, '220011', 2_000_00);
    const rcpt = await receivePayment(f.trx, f.orgId, null, {
      branchId: f.branchId, contactId: f.customer, date: '2026-06-02', mode: 'cheque', reference: '220011',
      amountPaise: 2_000_00, bankAccountId: f.bankId,
    });
    await assert.rejects(moveCheque(f.trx, f.orgId, chq, 'cancelled'), /Void that payment first/);
    await voidPayment(f.trx, f.orgId, null, rcpt.id, 'Entered twice');
    await moveCheque(f.trx, f.orgId, chq, 'cancelled');
    await assert.rejects(clearCheque(f.trx, f.orgId, chq, { date: '2026-06-04' }), /cancelled/);
  });
});

test('a payment cannot be reversed before the day it was made', async () => {
  await withFixture(async (f) => {
    const rcpt = await receivePayment(f.trx, f.orgId, null, {
      branchId: f.branchId, contactId: f.customer, date: '2026-06-10', mode: 'neft', amountPaise: 1_000_00, bankAccountId: f.bankId,
    });
    await assert.rejects(voidPayment(f.trx, f.orgId, null, rcpt.id, 'x', { date: '2026-06-09' }), /earlier day/);
  });
});

test('the section 138 notice is due thirty days after the return memo', () => {
  assert.equal(noticeDeadline('2026-06-06'), '2026-07-06');
  assert.equal(noticeDeadline('2026-01-31'), '2026-03-02');
});

test.after(async () => {
  await db.destroy();
});
