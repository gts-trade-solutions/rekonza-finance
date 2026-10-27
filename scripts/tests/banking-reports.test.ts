// Banking and the financial statements, against real MySQL.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/banking-reports.test.ts
//
// The statement tests are the ones that matter most: a report that is merely
// self-consistent proves nothing, so these check the statements against each
// other. If the trial balance ties but the balance sheet does not, the two are
// reading the same journal differently and one of them is lying.

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill, createExpense } from '../../lib/server/services/purchases';
import { receivePayment, makePayment } from '../../lib/server/services/payments';
import {
  importStatement, categoriseTransaction, matchToPayment, unmatchTransaction,
  createTransfer, createBankAccount, bankBalances,
} from '../../lib/server/services/banking';
import {
  trialBalance, profitAndLoss, balanceSheet, generalLedger, ageing,
} from '../../lib/server/reports/statements';
import { toPaiseFromSql } from '../../lib/server/money-sql';

interface Fixture {
  trx: Trx;
  orgId: number;
  branchId: number;
  acc: Record<string, number>;
  customerId: number;
  vendorId: number;
  bankId: number;
  itemId: number;
}

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const org = await trx.insertInto('organizations')
        .values({ name: 'Banking Test Co' }).executeTakeFirstOrThrow();
      const orgId = Number(org.insertId);

      const branch = await trx.insertInto('branches')
        .values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 })
        .executeTakeFirstOrThrow();
      const branchId = Number(branch.insertId);

      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);

      const mk = async (v: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values(v as never).executeTakeFirstOrThrow()).insertId);

      const customerId = await mk({
        org_id: orgId, kind: 'customer', display_name: 'Customer A',
        gst_treatment: 'registered', state_code: '33',
      });
      const vendorId = await mk({
        org_id: orgId, kind: 'vendor', display_name: 'Vendor B',
        gst_treatment: 'registered', state_code: '33',
      });

      const bank = await trx.insertInto('bank_accounts')
        .values({
          org_id: orgId, kind: 'bank', name: 'Main Bank',
          ledger_account_id: acc[CODE.BANK_DEFAULT],
          opening_balance: '0.0000', opening_date: null, is_primary: 1,
        })
        .executeTakeFirstOrThrow();
      const bankId = Number(bank.insertId);

      const item = await trx.insertInto('items')
        .values({
          org_id: orgId, kind: 'goods', name: 'Widget', sku: 'W-1', hsn_sac: '8708',
          uqc: 'NOS', sale_price: '1000.0000', purchase_price: '600.0000',
          gst_rate_pct: 18, sale_account_id: acc[CODE.SALES],
          purchase_account_id: acc[CODE.PURCHASES],
        })
        .executeTakeFirstOrThrow();
      const itemId = Number(item.insertId);

      await trx.insertInto('hsn_codes').values({
        org_id: orgId, code: '8708', kind: 'hsn', description: 'Parts',
        gst_rate_pct: 18, is_active: 1,
      }).execute();

      await fn({ trx, orgId, branchId, acc, customerId, vendorId, bankId, itemId });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const STATEMENT = [
  { date: '2026-08-01', narration: 'NEFT FROM CUSTOMER A', depositPaise: 118_000 },
  { date: '2026-08-03', narration: 'BHARAT PETRO FUEL', withdrawalPaise: 45_00 },
  { date: '2026-08-05', narration: 'CITY PROPERTIES RENT', withdrawalPaise: 850_00 },
];

test('imports statement lines and leaves them unmatched', async () => {
  await withFixture(async ({ trx, orgId, bankId }) => {
    const result = await importStatement(trx, orgId, null, bankId, 'aug.csv', STATEMENT);
    assert.equal(result.total, 3);
    assert.equal(result.imported, 3);
    assert.equal(result.duplicates, 0);
    assert.equal(result.periodFrom, '2026-08-01');
    assert.equal(result.periodTo, '2026-08-05');

    const rows = await trx.selectFrom('bank_transactions')
      .select(['status']).where('org_id', '=', orgId).execute();
    assert.equal(rows.length, 3);
    // A statement line is evidence, not a transaction. Nothing posts until
    // somebody says what it was for.
    assert.ok(rows.every((r) => r.status === 'unmatched'));

    const check = await verifyLedgerBalances(trx, orgId);
    assert.equal(check.totalDebit, 0, 'importing posts nothing to the ledger');
  });
});

test('re-importing an overlapping statement adds nothing twice', async () => {
  await withFixture(async ({ trx, orgId, bankId }) => {
    await importStatement(trx, orgId, null, bankId, 'aug.csv', STATEMENT);

    // The normal case: you download December-to-January after January.
    const overlapping = [
      ...STATEMENT,
      { date: '2026-08-09', narration: 'NEW LINE', depositPaise: 5_000 },
    ];
    const second = await importStatement(trx, orgId, null, bankId, 'aug-sep.csv', overlapping);

    assert.equal(second.total, 4);
    assert.equal(second.duplicates, 3, 'the three already there were skipped');
    assert.equal(second.imported, 1, 'only the genuinely new line was added');

    const all = await trx.selectFrom('bank_transactions')
      .select('id').where('org_id', '=', orgId).execute();
    assert.equal(all.length, 4, 'no doubling');
  });
});

test('a repeated line within one file is imported once', async () => {
  await withFixture(async ({ trx, orgId, bankId }) => {
    const dup = { date: '2026-08-01', narration: 'SAME LINE', withdrawalPaise: 1_000 };
    const res = await importStatement(trx, orgId, null, bankId, 'dupes.csv', [dup, dup, dup]);
    assert.equal(res.imported, 1);
    assert.equal(res.duplicates, 2);
  });
});

test('refuses a line that is both a deposit and a withdrawal', async () => {
  await withFixture(async ({ trx, orgId, bankId }) => {
    await assert.rejects(
      () => importStatement(trx, orgId, null, bankId, 'bad.csv', [
        { date: '2026-08-01', narration: 'Confused', depositPaise: 100, withdrawalPaise: 100 },
      ]),
      /both a deposit and a withdrawal/,
    );
  });
});

test('categorising a line posts it against the chosen account', async () => {
  await withFixture(async ({ trx, orgId, bankId, acc }) => {
    await importStatement(trx, orgId, null, bankId, 'aug.csv', STATEMENT);
    const fuel = await trx.selectFrom('bank_transactions')
      .select(['id', 'withdrawal']).where('org_id', '=', orgId)
      .where('narration', 'like', '%FUEL%').executeTakeFirstOrThrow();

    const entryId = await categoriseTransaction(trx, orgId, null, fuel.id, {
      accountId: acc[CODE.FUEL],
    });

    const lines = await trx.selectFrom('journal_lines')
      .select(['account_id', 'debit', 'credit']).where('entry_id', '=', entryId).execute();
    const fuelLine = lines.find((l) => l.account_id === acc[CODE.FUEL]);
    const bankLine = lines.find((l) => l.account_id === acc[CODE.BANK_DEFAULT]);
    assert.equal(toPaiseFromSql(fuelLine!.debit), 45_00);
    assert.equal(toPaiseFromSql(bankLine!.credit), 45_00);

    assert.ok((await verifyLedgerBalances(trx, orgId)).balanced);
  });
});

test('matching a line to an existing payment posts nothing', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, itemId, bankId }) => {
    const inv = await createInvoice(trx, orgId, null, {
      branchId, customerId, date: '2026-08-01', dueDate: '2026-08-31',
      status: 'approved', lines: [{ itemId, qty: 1, ratePaise: 100_000 }],
    });
    const pay = await receivePayment(trx, orgId, null, {
      branchId, contactId: customerId, date: '2026-08-01', mode: 'neft',
      amountPaise: inv.totalPaise, bankAccountId: bankId,
      allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: inv.totalPaise }],
    });

    const before = await verifyLedgerBalances(trx, orgId);

    await importStatement(trx, orgId, null, bankId, 'aug.csv', [
      { date: '2026-08-01', narration: 'NEFT FROM CUSTOMER A', depositPaise: inv.totalPaise },
    ]);
    const line = await trx.selectFrom('bank_transactions')
      .select('id').where('org_id', '=', orgId).executeTakeFirstOrThrow();

    await matchToPayment(trx, orgId, null, line.id, pay.id);

    const after = await verifyLedgerBalances(trx, orgId);
    // The payment already posted when it was recorded. Posting again on match
    // would double the money.
    assert.equal(after.totalDebit, before.totalDebit, 'nothing new was posted');

    const status = await trx.selectFrom('bank_transactions')
      .select(['status', 'matched_type']).where('id', '=', line.id).executeTakeFirstOrThrow();
    assert.equal(status.status, 'matched');
    assert.equal(status.matched_type, 'payment');
  });
});

test('refuses to match a line to a payment of a different amount', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, bankId }) => {
    const pay = await receivePayment(trx, orgId, null, {
      branchId, contactId: customerId, date: '2026-08-01', mode: 'neft',
      amountPaise: 100_000, bankAccountId: bankId,
    });
    await importStatement(trx, orgId, null, bankId, 'aug.csv', [
      { date: '2026-08-01', narration: 'NEFT', depositPaise: 99_000 },
    ]);
    const line = await trx.selectFrom('bank_transactions')
      .select('id').where('org_id', '=', orgId).executeTakeFirstOrThrow();

    // Forcing these together would bury a real 10-rupee difference.
    await assert.rejects(
      () => matchToPayment(trx, orgId, null, line.id, pay.id),
      /would hide a real difference/,
    );
  });
});

test('refuses to match a deposit to a payment made', async () => {
  await withFixture(async ({ trx, orgId, branchId, vendorId, bankId }) => {
    const pay = await makePayment(trx, orgId, null, {
      branchId, contactId: vendorId, date: '2026-08-01', mode: 'neft',
      amountPaise: 50_000, bankAccountId: bankId,
    });
    await importStatement(trx, orgId, null, bankId, 'aug.csv', [
      { date: '2026-08-01', narration: 'MONEY IN', depositPaise: 50_000 },
    ]);
    const line = await trx.selectFrom('bank_transactions')
      .select('id').where('org_id', '=', orgId).executeTakeFirstOrThrow();

    await assert.rejects(
      () => matchToPayment(trx, orgId, null, line.id, pay.id),
      /cannot be the same transaction/,
    );
  });
});

test('unmatching a categorised line reverses what it posted', async () => {
  await withFixture(async ({ trx, orgId, bankId, acc }) => {
    await importStatement(trx, orgId, null, bankId, 'aug.csv', STATEMENT);
    const line = await trx.selectFrom('bank_transactions')
      .select('id').where('org_id', '=', orgId)
      .where('narration', 'like', '%FUEL%').executeTakeFirstOrThrow();

    await categoriseTransaction(trx, orgId, null, line.id, { accountId: acc[CODE.FUEL] });
    await unmatchTransaction(trx, orgId, null, line.id);

    const after = await trx.selectFrom('bank_transactions')
      .select(['status', 'matched_id']).where('id', '=', line.id).executeTakeFirstOrThrow();
    assert.equal(after.status, 'unmatched');
    assert.equal(after.matched_id, null);

    // The original entry and its reversal both remain; the net effect is nil.
    const entries = await trx.selectFrom('journal_entries')
      .select('id').where('org_id', '=', orgId).execute();
    assert.equal(entries.length, 2, 'a correction is posted, not erased');
    assert.ok((await verifyLedgerBalances(trx, orgId)).balanced);
  });
});

test('a transfer moves money without touching profit', async () => {
  await withFixture(async ({ trx, orgId, bankId }) => {
    const second = await createBankAccount(trx, orgId, null, {
      kind: 'bank', name: 'Second Bank',
    });

    await createTransfer(trx, orgId, null, {
      fromBankAccountId: bankId,
      toBankAccountId: second.id,
      date: '2026-08-10',
      amountPaise: 500_000,
    });

    const pl = await profitAndLoss(trx, orgId, '2026-04-01', '2027-03-31');
    // Moving your own money is neither income nor expense.
    assert.equal(pl.totalIncome, 0);
    assert.equal(pl.totalExpense, 0);
    assert.ok((await verifyLedgerBalances(trx, orgId)).balanced);
  });
});

test('refuses a transfer to the same account', async () => {
  await withFixture(async ({ trx, orgId, bankId }) => {
    await assert.rejects(
      () => createTransfer(trx, orgId, null, {
        fromBankAccountId: bankId, toBankAccountId: bankId,
        date: '2026-08-10', amountPaise: 1000,
      }),
      /two different accounts/,
    );
  });
});

test('the bank balance follows what was posted to its ledger account', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, itemId, bankId }) => {
    const inv = await createInvoice(trx, orgId, null, {
      branchId, customerId, date: '2026-08-01', dueDate: '2026-08-31',
      status: 'approved', lines: [{ itemId, qty: 1, ratePaise: 100_000 }],
    });
    await receivePayment(trx, orgId, null, {
      branchId, contactId: customerId, date: '2026-08-02', mode: 'neft',
      amountPaise: inv.totalPaise, bankAccountId: bankId,
      allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: inv.totalPaise }],
    });

    const balances = await bankBalances(trx, orgId);
    const main = balances.find((b) => b.id === bankId)!;
    assert.equal(main.balancePaise, inv.totalPaise);
  });
});

// ── Statements ───────────────────────────────────────────────────────────────

/** A small but complete book: sales, purchases, payments, an expense. */
async function buildBook(f: Fixture) {
  const { trx, orgId, branchId, customerId, vendorId, itemId, bankId, acc } = f;

  for (let i = 0; i < 6; i++) {
    const inv = await createInvoice(trx, orgId, null, {
      branchId, customerId, date: '2026-08-05', dueDate: '2026-09-04',
      status: 'approved', lines: [{ itemId, qty: 2 + i, ratePaise: 100_000 + i * 313 }],
    });
    // Settle four of the six, so there is something left in receivables.
    if (i < 4) {
      await receivePayment(trx, orgId, null, {
        branchId, contactId: customerId, date: '2026-08-20', mode: 'neft',
        amountPaise: inv.totalPaise, bankAccountId: bankId,
        allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: inv.totalPaise }],
      });
    }
  }

  for (let i = 0; i < 4; i++) {
    const bill = await createBill(trx, orgId, null, {
      branchId, vendorId, vendorInvoiceNo: `BK-${i}`,
      date: '2026-08-06', dueDate: '2026-09-05',
      lines: [{ itemId, qty: 2 + i, ratePaise: 60_000 + i * 97 }],
    });
    if (i < 2) {
      await makePayment(trx, orgId, null, {
        branchId, contactId: vendorId, date: '2026-08-21', mode: 'neft',
        amountPaise: bill.totalPaise, bankAccountId: bankId,
        allocations: [{ targetType: 'bill', targetId: bill.id, amountPaise: bill.totalPaise }],
      });
    }
  }

  await createExpense(trx, orgId, null, {
    branchId, date: '2026-08-15', accountId: acc[CODE.RENT],
    paidThroughBankAccountId: bankId, amountPaise: 8_50_000, gstRatePct: 18,
  });
}

test('the trial balance ties exactly', async () => {
  await withFixture(async (f) => {
    await buildBook(f);
    const tb = await trialBalance(f.trx, f.orgId, '2027-03-31');
    assert.ok(tb.balanced, `off by ${tb.totalDebit - tb.totalCredit} paise`);
    assert.ok(tb.totalDebit > 0, 'there is something to report');
    assert.equal(tb.totalDebit, tb.totalCredit);
  });
});

test('the balance sheet balances, including this year’s profit', async () => {
  await withFixture(async (f) => {
    await buildBook(f);
    const bs = await balanceSheet(f.trx, f.orgId, '2027-03-31');
    // The piece people miss: profit earned this year has not moved into
    // retained earnings yet, but it belongs to the owners all the same.
    assert.ok(bs.balanced, `assets ${bs.totalAssets} vs L+E ${bs.totalLiabilities + bs.totalEquity}`);
    assert.equal(bs.totalAssets, bs.totalLiabilities + bs.totalEquity);
    assert.notEqual(bs.currentPeriodEarnings, 0);
  });
});

test('the profit and loss agrees with the balance sheet', async () => {
  await withFixture(async (f) => {
    await buildBook(f);
    const pl = await profitAndLoss(f.trx, f.orgId, '2026-04-01', '2027-03-31');
    const bs = await balanceSheet(f.trx, f.orgId, '2027-03-31');
    // Two reports reading the same journal must reach the same profit. If they
    // ever diverge, one of them is aggregating incorrectly.
    assert.equal(pl.netProfit, bs.currentPeriodEarnings);
  });
});

test('receivables ageing matches the receivable account balance', async () => {
  await withFixture(async (f) => {
    await buildBook(f);
    const ar = await ageing(f.trx, f.orgId, 'receivable', '2026-08-31');
    const tb = await trialBalance(f.trx, f.orgId, '2026-08-31');
    const arAccount = tb.rows.find((r) => r.code === CODE.AR);

    // The subsidiary ledger has to agree with the control account. When these
    // drift, one invoice has been settled in one place and not the other.
    assert.equal(ar.grandTotalPaise, arAccount?.balancePaise ?? 0);
    assert.ok(ar.rows.length > 0);
  });
});

test('payables ageing matches the payable account balance', async () => {
  await withFixture(async (f) => {
    await buildBook(f);
    const ap = await ageing(f.trx, f.orgId, 'payable', '2026-08-31');
    const tb = await trialBalance(f.trx, f.orgId, '2026-08-31');
    const apAccount = tb.rows.find((r) => r.code === CODE.AP);
    assert.equal(ap.grandTotalPaise, apAccount?.balancePaise ?? 0);
  });
});

test('the general ledger running balance ends at the account balance', async () => {
  await withFixture(async (f) => {
    await buildBook(f);
    const gl = await generalLedger(f.trx, f.orgId, f.acc[CODE.BANK_DEFAULT], '2026-04-01', '2027-03-31');
    const balances = await bankBalances(f.trx, f.orgId);
    const main = balances.find((b) => b.id === f.bankId)!;
    assert.equal(gl.closingPaise, main.balancePaise);
    assert.ok(gl.lines.length > 0);
  });
});

test('a period restricts the profit and loss but not the balance sheet', async () => {
  await withFixture(async (f) => {
    await buildBook(f);
    // Nothing happened in September; the profit for that month alone is nil,
    // while the balance sheet still shows everything accumulated to that date.
    const sept = await profitAndLoss(f.trx, f.orgId, '2026-09-01', '2026-09-30');
    assert.equal(sept.totalIncome, 0);
    assert.equal(sept.totalExpense, 0);

    const bs = await balanceSheet(f.trx, f.orgId, '2026-09-30');
    assert.notEqual(bs.totalAssets, 0, 'the position carries forward');
    assert.ok(bs.balanced);
  });
});

test.after(async () => {
  await db.destroy();
});
