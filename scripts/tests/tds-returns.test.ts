// TDS deposits and the quarterly return.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/tds-returns.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createBill } from '../../lib/server/services/purchases';
import {
  depositDueDate, formFor, quarterRange, quarterReturn, recordChallan, returnDueDate,
} from '../../lib/server/tax/tds-returns';
import { toPaiseFromSql } from '../../lib/server/money-sql';

interface Fixture { trx: Trx; orgId: number; branchId: number; vendorId: number; bankId: number }

async function withFixture(fn: (f: Fixture) => Promise<void>, tan: string | null = 'CHER12345A') {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'TDS Test Co', tan }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches')
        .values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const vendorId = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'vendor', display_name: 'Auditors & Co', gst_treatment: 'registered',
        state_code: '33', pan: 'AAAFA1234B', tds_section: '194J',
      }).executeTakeFirstOrThrow()).insertId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'Current A/c', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
      }).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, vendorId, bankId });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test('quarters, due dates and form numbers', () => {
  assert.deepEqual(quarterRange(2026, 4), { from: '2027-01-01', to: '2027-03-31', months: ['2027-01', '2027-02', '2027-03'] });
  assert.equal(depositDueDate('2026-08'), '2026-09-07');
  assert.equal(depositDueDate('2027-03'), '2027-04-30', 'March has until 30 April');
  assert.equal(depositDueDate('2026-12'), '2027-01-07');
  assert.equal(returnDueDate(2026, 4), '2027-05-31');
  assert.equal(formFor('resident', '2026-07-01'), 'Form 140');
  assert.equal(formFor('resident', '2026-01-01'), 'Form 26Q', 'the old form before the 2025 Act');
  assert.equal(formFor('tcs', '2026-07-01'), 'Form 143');
});

test('a deduction with no challan is flagged, and a challan clears it', async () => {
  await withFixture(async ({ trx, orgId, branchId, vendorId, bankId }) => {
    await createBill(trx, orgId, null, {
      branchId, vendorId, vendorInvoiceNo: 'AUD-1', date: '2026-08-10', dueDate: '2026-09-10',
      lines: [{ description: 'Audit fee', qty: 1, ratePaise: 80_000_00, gstRatePct: 18 }],
    });

    let r = await quarterReturn(trx, orgId, 2026, 2);
    assert.equal(r.forms[0].form, 'Form 140');
    assert.equal(r.forms[0].rows[0].sectionLabel, '393(1) Table Sl. 6(iii)(b) (earlier 194J)');
    assert.equal(r.forms[0].totalTaxPaise, 8_000_00);
    const august = r.deposits.tds.find((m) => m.month === '2026-08')!;
    assert.equal(august.status, 'unpaid');
    assert.ok(r.issues.some((i) => /not deposited/.test(i.message)));

    // Paid two days late, with interest.
    const ch = await recordChallan(trx, orgId, null, branchId, {
      kind: 'tds', forMonth: '2026-08', date: '2026-09-09', bsrCode: '0510308', serial: '12345',
      taxPaise: 8_000_00, interestPaise: 120_00, bankAccountId: bankId,
    });
    r = await quarterReturn(trx, orgId, 2026, 2);
    const paid = r.deposits.tds.find((m) => m.month === '2026-08')!;
    assert.equal(paid.status, 'paid');
    assert.equal(paid.daysLate, 2);
    assert.ok(r.issues.some((i) => /after the due date/.test(i.message)));

    // The payment cleared the tax held, and the interest is a cost.
    const lines = await trx.selectFrom('journal_lines').innerJoin('accounts', 'accounts.id', 'journal_lines.account_id')
      .select(['accounts.code', 'journal_lines.debit', 'journal_lines.credit'])
      .where('journal_lines.entry_id', '=', ch.journalEntryId).execute();
    const dr = (code: string) => toPaiseFromSql(lines.find((l) => l.code === code)?.debit ?? '0');
    assert.equal(dr(CODE.TDS_PAYABLE), 8_000_00);
    assert.equal(dr(CODE.TAX_INTEREST), 120_00);
  });
});

test('a book with no TAN is told so', async () => {
  await withFixture(async ({ trx, orgId }) => {
    const r = await quarterReturn(trx, orgId, 2026, 2);
    assert.ok(r.issues.some((i) => /no TAN/.test(i.message)));
  }, null);
});

test('a challan needs a real BSR code', async () => {
  await withFixture(async ({ trx, orgId, branchId, bankId }) => {
    await assert.rejects(recordChallan(trx, orgId, null, branchId, {
      kind: 'tds', forMonth: '2026-08', date: '2026-09-05', bsrCode: '12', serial: '1', taxPaise: 100, bankAccountId: bankId,
    }), /BSR code/);
  });
});

test.after(async () => {
  await db.destroy();
});
