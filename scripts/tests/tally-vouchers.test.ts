// A connected Tally company's vouchers, brought into the books as journals.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/tally-vouchers.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { setBooksStartDate } from '../../lib/server/services/opening-balances';
import { importTallyVouchers } from '../../lib/server/imports/tally';

interface Fixture { trx: Trx; orgId: number; branchId: number; companyId: number; acc: Record<string, number>; customer: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Tally Import Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      await setBooksStartDate(trx, orgId, '2026-04-01');
      const acc = await accountIds(trx, orgId);
      const connectorId = Number((await trx.insertInto('tally_connectors').values({ org_id: orgId, status: 'active' } as never).executeTakeFirstOrThrow()).insertId);
      const companyId = Number((await trx.insertInto('tally_companies').values({
        org_id: orgId, connector_id: connectorId, guid: 'co-1', name: 'Old Books',
      } as never).executeTakeFirstOrThrow()).insertId);
      await trx.insertInto('tally_groups').values([
        { company_id: companyId, name: 'Sundry Debtors', parent: null, nature: 'assets' },
        { company_id: companyId, name: 'Bank Accounts', parent: null, nature: 'assets' },
        { company_id: companyId, name: 'Sales Accounts', parent: null, nature: 'income' },
        { company_id: companyId, name: 'Duties & Taxes', parent: null, nature: 'liabilities' },
        { company_id: companyId, name: 'Indirect Expenses', parent: null, nature: 'expenses' },
      ] as never).execute();
      await trx.insertInto('tally_ledgers').values([
        { company_id: companyId, name: 'Sharma Traders', parent: 'Sundry Debtors' },
        { company_id: companyId, name: 'HDFC Current', parent: 'Bank Accounts' },
        { company_id: companyId, name: 'Sales', parent: 'Sales Accounts' },
        { company_id: companyId, name: 'Output CGST 9%', parent: 'Duties & Taxes', closing_paise: -100 },
        { company_id: companyId, name: 'Output SGST 9%', parent: 'Duties & Taxes', closing_paise: -100 },
        { company_id: companyId, name: 'Courier Charges', parent: 'Indirect Expenses' },
      ] as never).execute();
      const customer = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'customer', display_name: 'Sharma Traders', state_code: '33', gst_treatment: 'unregistered',
      } as never).executeTakeFirstOrThrow()).insertId);
      await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'HDFC Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
      }).execute();
      await fn({ trx, orgId, branchId, companyId, acc, customer });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

async function voucher(f: Fixture, guid: string, type: string, date: string, lines: [string, number, number][], extra: Record<string, unknown> = {}) {
  const id = Number((await f.trx.insertInto('tally_vouchers').values({
    company_id: f.companyId, guid, voucher_type: type, base_type: type, number: guid.toUpperCase(), date,
    amount_paise: lines.reduce((t, l) => t + l[1], 0), ...extra,
  } as never).executeTakeFirstOrThrow()).insertId);
  await f.trx.insertInto('tally_voucher_entries').values(lines.map(([ledger, debit, credit], i) => ({
    voucher_id: id, company_id: f.companyId, line_no: i + 1, ledger, debit_paise: debit, credit_paise: credit,
  })) as never).execute();
}

const ctx = (f: Fixture) => ({ orgId: f.orgId, userId: null, branchId: f.branchId, onDuplicate: 'skip' as const });

test('vouchers post as journals, mapped ledger by ledger, once', async () => {
  await withFixture(async (f) => {
    await voucher(f, 's-1', 'Sales', '2026-05-02', [['Sharma Traders', 11_800_00, 0], ['Sales', 0, 10_000_00], ['Output CGST 9%', 0, 900_00], ['Output SGST 9%', 0, 900_00]]);
    await voucher(f, 'r-1', 'Receipt', '2026-05-20', [['HDFC Current', 11_800_00, 0], ['Sharma Traders', 0, 11_800_00]]);
    await voucher(f, 'old', 'Sales', '2026-03-15', [['Sharma Traders', 100, 0], ['Sales', 0, 100]]);
    await voucher(f, 'cxl', 'Sales', '2026-05-03', [['Sharma Traders', 100, 0], ['Sales', 0, 100]], { is_cancelled: 1 });
    // Courier Charges has no account here yet.
    await voucher(f, 'p-1', 'Payment', '2026-05-25', [['Courier Charges', 500_00, 0], ['HDFC Current', 0, 500_00]]);

    const out = await importTallyVouchers(f.trx, ctx(f), f.companyId);
    assert.equal(out.created, 2);
    assert.equal(out.errors.length, 1);
    assert.match(out.errors[0].message, /no account for Courier Charges/);

    const { rows } = await sql<{ v: string }>`
      SELECT COALESCE(SUM(debit - credit), 0) AS v FROM journal_lines
       WHERE org_id = ${f.orgId} AND account_id = ${f.acc[CODE.AR]} AND contact_id = ${f.customer}`.execute(f.trx);
    assert.equal(Number(rows[0].v), 0, 'billed and paid');
    const gst = await sql<{ v: string }>`SELECT COALESCE(SUM(credit), 0) AS v FROM journal_lines WHERE org_id = ${f.orgId} AND account_id = ${f.acc[CODE.GST_CGST]}`.execute(f.trx);
    assert.equal(Number(gst.rows[0].v), 900);
    assert.ok((await verifyLedgerBalances(f.trx, f.orgId)).balanced);

    // The missing ledger added, the run repeated: only the new one comes across.
    await f.trx.insertInto('accounts').values({ org_id: f.orgId, code: '6650', name: 'Courier Charges', type: 'expense' }).execute();
    const again = await importTallyVouchers(f.trx, ctx(f), f.companyId);
    assert.equal(again.created, 1);
    assert.equal(again.skipped, 2);
  });
});

test.after(async () => {
  await db.destroy();
});
