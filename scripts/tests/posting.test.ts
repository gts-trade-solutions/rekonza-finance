// The posting engine, against a real MySQL database.
//   npx tsx --env-file=.env.local --test scripts/tests/posting.test.ts
//
// Every test runs inside a transaction that is rolled back, so the suite leaves
// no rows behind and can run against a database with real data in it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import {
  postEntry, reverseEntry, allocateNumber, peekNumber, assertPeriodOpen,
  verifyLedgerBalances, UnbalancedEntryError, PeriodLockedError,
} from '../../lib/server/ledger/posting';
import {
  installChartOfAccounts, accountIds, CODE, STANDARD_ACCOUNTS,
} from '../../lib/server/ledger/chart-of-accounts';
import type { Trx } from '../../lib/server/db';

/** Build a throwaway org inside a transaction, then run the body and roll back. */
async function withFixture(
  fn: (ctx: {
    trx: Trx;
    orgId: number;
    branchId: number;
    acc: Record<string, number>;
  }) => Promise<void>,
) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const org = await trx
        .insertInto('organizations')
        .values({ name: 'Test Co', pan: 'AAAAA0000A' })
        .executeTakeFirstOrThrow();
      const orgId = Number(org.insertId);

      const branch = await trx
        .insertInto('branches')
        .values({ org_id: orgId, name: 'HQ', state_code: '33', gstin: null, is_primary: 1 })
        .executeTakeFirstOrThrow();
      const branchId = Number(branch.insertId);

      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);

      await fn({ trx, orgId, branchId, acc });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test('installs the standard chart of accounts', async () => {
  await withFixture(async ({ acc }) => {
    assert.equal(Object.keys(acc).length, STANDARD_ACCOUNTS.length);
    assert.ok(acc[CODE.AR], 'Accounts Receivable exists');
    assert.ok(acc[CODE.GST_CGST], 'Output CGST exists');
  });
});

test('installing twice adds nothing the second time', async () => {
  await withFixture(async ({ trx, orgId }) => {
    const added = await installChartOfAccounts(trx, orgId);
    assert.equal(added, 0, 'second install is a no-op');
  });
});

test('posts a balanced entry and returns it', async () => {
  await withFixture(async ({ trx, orgId, branchId, acc }) => {
    const posted = await postEntry(trx, {
      orgId, branchId, date: '2026-08-07', sourceType: 'manual',
      memo: 'Cash sale',
      lines: [
        { accountId: acc[CODE.CASH], debit: 118_00 },
        { accountId: acc[CODE.SALES], credit: 100_00 },
        { accountId: acc[CODE.GST_CGST], credit: 9_00 },
        { accountId: acc[CODE.GST_SGST], credit: 9_00 },
      ],
    });
    assert.equal(posted.entryNo, 1);
    assert.equal(posted.totalDebit, 11800);
    assert.equal(posted.totalCredit, 11800);

    const lines = await trx.selectFrom('journal_lines')
      .selectAll().where('entry_id', '=', posted.id).execute();
    assert.equal(lines.length, 4);
  });
});

test('refuses an unbalanced entry and writes nothing', async () => {
  await withFixture(async ({ trx, orgId, branchId, acc }) => {
    await assert.rejects(
      () => postEntry(trx, {
        orgId, branchId, date: '2026-08-07', sourceType: 'manual',
        lines: [
          { accountId: acc[CODE.CASH], debit: 100_00 },
          { accountId: acc[CODE.SALES], credit: 90_00 },
        ],
      }),
      (err: Error) => {
        assert.ok(err instanceof UnbalancedEntryError);
        // The message has to name the shortfall; an accountant fixes a
        // difference, not a constraint name.
        assert.match(err.message, /difference of 10\.00/);
        return true;
      },
    );
    const n = await trx.selectFrom('journal_entries').select('id').where('org_id', '=', orgId).execute();
    assert.equal(n.length, 0, 'nothing was written');
  });
});

test('refuses a line that is both a debit and a credit', async () => {
  await withFixture(async ({ trx, orgId, branchId, acc }) => {
    await assert.rejects(
      () => postEntry(trx, {
        orgId, branchId, date: '2026-08-07', sourceType: 'manual',
        lines: [
          { accountId: acc[CODE.CASH], debit: 100_00, credit: 100_00 },
          { accountId: acc[CODE.SALES], credit: 100_00 },
        ],
      }),
      /both a debit and a credit/,
    );
  });
});

test('refuses a negative amount', async () => {
  await withFixture(async ({ trx, orgId, branchId, acc }) => {
    await assert.rejects(
      () => postEntry(trx, {
        orgId, branchId, date: '2026-08-07', sourceType: 'manual',
        lines: [
          { accountId: acc[CODE.CASH], debit: -100_00 },
          { accountId: acc[CODE.SALES], credit: -100_00 },
        ],
      }),
      /Negative amounts are not postable/,
    );
  });
});

test('refuses a one-sided entry', async () => {
  await withFixture(async ({ trx, orgId, branchId, acc }) => {
    await assert.rejects(
      () => postEntry(trx, {
        orgId, branchId, date: '2026-08-07', sourceType: 'manual',
        lines: [{ accountId: acc[CODE.CASH], debit: 0 }, { accountId: acc[CODE.SALES], credit: 0 }],
      }),
      /at least two lines/,
    );
  });
});

test('entry numbers are sequential per organisation', async () => {
  await withFixture(async ({ trx, orgId, branchId, acc }) => {
    const pair = (n: number) => ({
      orgId, branchId, date: '2026-08-07', sourceType: 'manual' as const,
      lines: [
        { accountId: acc[CODE.CASH], debit: n },
        { accountId: acc[CODE.SALES], credit: n },
      ],
    });
    assert.equal((await postEntry(trx, pair(100))).entryNo, 1);
    assert.equal((await postEntry(trx, pair(200))).entryNo, 2);
    assert.equal((await postEntry(trx, pair(300))).entryNo, 3);
  });
});

test('reversing an entry mirrors every line', async () => {
  await withFixture(async ({ trx, orgId, branchId, acc }) => {
    const original = await postEntry(trx, {
      orgId, branchId, date: '2026-08-07', sourceType: 'invoice', memo: 'Invoice 1',
      lines: [
        { accountId: acc[CODE.AR], debit: 118_00 },
        { accountId: acc[CODE.SALES], credit: 100_00 },
        { accountId: acc[CODE.GST_IGST], credit: 18_00 },
      ],
    });

    const rev = await reverseEntry(trx, orgId, original.id);
    assert.equal(rev.totalDebit, original.totalCredit);

    const revLines = await trx.selectFrom('journal_lines')
      .select(['account_id', 'debit', 'credit'])
      .where('entry_id', '=', rev.id).orderBy('line_no').execute();

    // The receivable was debited; the reversal credits it.
    assert.equal(revLines[0].account_id, acc[CODE.AR]);
    assert.equal(Number(revLines[0].debit), 0);
    assert.equal(Number(revLines[0].credit), 118);

    const check = await verifyLedgerBalances(trx, orgId);
    assert.ok(check.balanced, 'ledger still balances after a reversal');
    assert.equal(check.totalDebit, check.totalCredit);
  });
});

test('the original entry survives its reversal untouched', async () => {
  await withFixture(async ({ trx, orgId, branchId, acc }) => {
    const original = await postEntry(trx, {
      orgId, branchId, date: '2026-08-07', sourceType: 'invoice',
      lines: [
        { accountId: acc[CODE.AR], debit: 500_00 },
        { accountId: acc[CODE.SALES], credit: 500_00 },
      ],
    });
    await reverseEntry(trx, orgId, original.id);

    const still = await trx.selectFrom('journal_entries')
      .selectAll().where('id', '=', original.id).executeTakeFirst();
    assert.ok(still, 'the original is still there');
    assert.equal(Number(still!.total_debit), 500);

    const entries = await trx.selectFrom('journal_entries')
      .select('id').where('org_id', '=', orgId).execute();
    assert.equal(entries.length, 2, 'a correction adds an entry, it does not remove one');
  });
});

test('refuses to reverse the same entry twice', async () => {
  await withFixture(async ({ trx, orgId, branchId, acc }) => {
    const original = await postEntry(trx, {
      orgId, branchId, date: '2026-08-07', sourceType: 'manual',
      lines: [
        { accountId: acc[CODE.CASH], debit: 100_00 },
        { accountId: acc[CODE.SALES], credit: 100_00 },
      ],
    });
    await reverseEntry(trx, orgId, original.id);
    await assert.rejects(() => reverseEntry(trx, orgId, original.id), /already been reversed/);
  });
});

test('a locked period refuses a posting dated inside it', async () => {
  await withFixture(async ({ trx, orgId, branchId, acc }) => {
    await trx.insertInto('transaction_locks').values({
      org_id: orgId, module: 'sales', locked_upto: '2026-07-31', reason: 'GSTR-3B filed',
    }).execute();

    await assert.rejects(
      () => assertPeriodOpen(trx, orgId, 'sales', '2026-07-15'),
      (err: Error) => {
        assert.ok(err instanceof PeriodLockedError);
        assert.match(err.message, /GSTR-3B filed/);
        return true;
      },
    );

    // The day after the lock is open, and other modules are unaffected.
    await assertPeriodOpen(trx, orgId, 'sales', '2026-08-01');
    await assertPeriodOpen(trx, orgId, 'purchases', '2026-07-15');

    await assert.rejects(
      () => postEntry(trx, {
        orgId, branchId, date: '2026-07-15', sourceType: 'invoice', module: 'sales',
        lines: [
          { accountId: acc[CODE.AR], debit: 100_00 },
          { accountId: acc[CODE.SALES], credit: 100_00 },
        ],
      }),
      PeriodLockedError,
    );
  });
});

test('allocates document numbers in sequence, per branch and year', async () => {
  await withFixture(async ({ trx, orgId, branchId }) => {
    assert.equal(await allocateNumber(trx, orgId, branchId, 'INV', '26-27', { prefix: 'INV' }), 'INV/26-27/0001');
    assert.equal(await allocateNumber(trx, orgId, branchId, 'INV', '26-27', { prefix: 'INV' }), 'INV/26-27/0002');
    // A different document type has its own run.
    assert.equal(await allocateNumber(trx, orgId, branchId, 'BILL', '26-27', { prefix: 'BILL' }), 'BILL/26-27/0001');
    // So does a different financial year.
    assert.equal(await allocateNumber(trx, orgId, branchId, 'INV', '27-28', { prefix: 'INV' }), 'INV/27-28/0001');
    // Peeking does not consume.
    assert.equal(await peekNumber(trx, orgId, branchId, 'INV', '26-27', 'INV'), 'INV/26-27/0003');
    assert.equal(await peekNumber(trx, orgId, branchId, 'INV', '26-27', 'INV'), 'INV/26-27/0003');
  });
});

test('a long run of postings still ties to the paisa', async () => {
  await withFixture(async ({ trx, orgId, branchId, acc }) => {
    // Amounts chosen to be awkward: 33.33 thirds do not divide evenly.
    for (let i = 1; i <= 200; i++) {
      const total = 3333 + i;
      const tax = Math.round(total * 0.18);
      await postEntry(trx, {
        orgId, branchId, date: '2026-08-07', sourceType: 'invoice',
        lines: [
          { accountId: acc[CODE.AR], debit: total + tax },
          { accountId: acc[CODE.SALES], credit: total },
          { accountId: acc[CODE.GST_IGST], credit: tax },
        ],
      });
    }
    const check = await verifyLedgerBalances(trx, orgId);
    assert.ok(check.balanced, 'still balanced after 200 postings');
    assert.equal(check.unbalancedEntries, 0);
    assert.equal(check.totalDebit, check.totalCredit);
  });
});

test.after(async () => {
  await db.destroy();
});
