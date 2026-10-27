// The cash book, and counting the cash against it.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/cash-book.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { receivePayment } from '../../lib/server/services/payments';
import { createExpense } from '../../lib/server/services/purchases';
import { cashBook, countCash } from '../../lib/server/reports/cash-book';
import { toPaiseFromSql } from '../../lib/server/money-sql';

test('receipts and payments by day, and a count that finds ₹50 short', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Cash Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'Shop', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const cashId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'cash', name: 'Counter cash', ledger_account_id: acc[CODE.CASH], opening_balance: '0.0000',
      }).executeTakeFirstOrThrow()).insertId);
      const customer = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'customer', display_name: 'Walk-in', state_code: '33', gst_treatment: 'consumer',
      } as never).executeTakeFirstOrThrow()).insertId);

      await receivePayment(trx, orgId, null, { branchId, contactId: customer, date: '2026-06-01', mode: 'cash', amountPaise: 5_000_00, bankAccountId: cashId });
      await createExpense(trx, orgId, null, { branchId, date: '2026-06-02', accountId: acc[CODE.OFFICE], paidThroughBankAccountId: cashId, amountPaise: 1_200_00 });

      const book = await cashBook(trx, orgId, cashId, '2026-06-01', '2026-06-30');
      assert.equal(book.openingPaise, 0);
      assert.deepEqual([book.receiptsPaise, book.paymentsPaise, book.closingPaise], [5_000_00, 1_200_00, 3_800_00]);
      assert.equal(book.days.length, 2);
      assert.equal(book.days[1].openingPaise, 5_000_00, 'each day opens where the last closed');
      assert.equal(book.days[0].lines[0].party, 'Walk-in');
      assert.equal((await cashBook(trx, orgId, cashId, '2026-06-02', '2026-06-30')).openingPaise, 5_000_00);

      await assert.rejects(countCash(trx, orgId, null, { bankAccountId: cashId, date: '2026-06-30', pieces: { 2000: 1 } }), /not a count/);
      const short = await countCash(trx, orgId, null, { bankAccountId: cashId, date: '2026-06-30', pieces: { 500: 7, 200: 1, 50: 1 } });
      assert.deepEqual([short.countedPaise, short.bookPaise, short.differencePaise], [3_750_00, 3_800_00, -50_00]);
      const ledger = async (code: string) => toPaiseFromSql((await sql<{ b: string }>`SELECT COALESCE(SUM(debit - credit), 0) AS b FROM journal_lines WHERE account_id = ${acc[code]}`.execute(trx)).rows[0].b);
      assert.equal(await ledger(CODE.CASH_SHORT_EXCESS), 50_00, 'the shortage is a cost');
      assert.equal(await ledger(CODE.CASH), 3_750_00, 'the books now agree with the drawer');

      const agreed = await countCash(trx, orgId, null, { bankAccountId: cashId, date: '2026-06-30', pieces: { 500: 7, 200: 1, 50: 1 } });
      assert.equal(agreed.differencePaise, 0);
      assert.equal(agreed.journalEntryId, null, 'nothing to post when it agrees');
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test.after(async () => {
  await db.destroy();
});
