// QuickBooks' files — Desktop's IIF, Online's lists and Journal report — read
// and brought into the books.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/quickbooks-import.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { setBooksStartDate } from '../../lib/server/services/opening-balances';
import { importTally, importTallyFileVouchers, QUICKBOOKS_COMPANY_ID } from '../../lib/server/imports/tally';
import { detectDateOrder, groupFor, iifRows, parseQuickBooks, qbAmount, qbDate, summariseQuickBooks, toImportShapes } from '../../lib/quickbooks/parse';
import { quickBooksSampleIif, QB_SAMPLE_CUSTOMER } from '../../lib/quickbooks/sample';

const TODAY = '2026-11-20';

test("QuickBooks' amounts and dates, as each edition writes them", () => {
  assert.equal(qbAmount('₹1,23,456.50'), 12_345_650);
  assert.equal(qbAmount('(1,200.00)'), -120_000);
  assert.equal(qbAmount('-75'), -7_500);
  assert.equal(qbAmount('500.00 Cr'), -50_000);
  assert.equal(qbAmount(''), null);
  assert.equal(qbDate('31/03/2026', 'dmy'), '2026-03-31');
  assert.equal(qbDate('03/31/2026', 'mdy'), '2026-03-31');
  assert.equal(qbDate('2026-03-31', 'mdy'), '2026-03-31');
  assert.equal(qbDate('31-Mar-2026', 'mdy'), '2026-03-31');
  assert.equal(qbDate('Mar 31, 2026', 'dmy'), '2026-03-31');
  assert.deepEqual(detectDateOrder(['04/11/2026', '25/11/2026']), { order: 'dmy', assumed: false });
  assert.deepEqual(detectDateOrder(['11/04/2026', '11/25/2026']), { order: 'mdy', assumed: false });
  assert.deepEqual(detectDateOrder(['04/11/2026']), { order: 'dmy', assumed: true }, 'undecided: day first, as in India');
});

test("account types land in the group that means the same — and a sales account named for GST stays income", () => {
  assert.equal(groupFor('BANK', 'ICICI Current'), 'Bank Accounts');
  assert.equal(groupFor('Bank', 'Petty Cash'), 'Cash-in-Hand');
  assert.equal(groupFor('Accounts receivable (A/R)', 'Accounts Receivable'), null);
  assert.equal(groupFor('Other Current Liabilities', 'Output IGST'), 'Duties & Taxes');
  assert.equal(groupFor('Income', 'Sales @ 18% GST'), 'Sales Accounts');
  assert.equal(groupFor('Expenses', 'Rent'), 'Indirect Expenses');
  assert.equal(groupFor('Cost of Goods Sold', 'Purchases'), 'Purchase Accounts');
  assert.equal(groupFor('Long Term Liabilities', 'Term Loan'), 'Loans (Liability)');
  assert.equal(groupFor('Other Current Assets', 'Inventory Asset'), 'Stock-in-Hand');
});

test('an IIF file: lists and transactions, each transaction balanced and read the right way round', () => {
  const d = parseQuickBooks([{ name: 'sample.iif', rows: iifRows(quickBooksSampleIif(TODAY)) }]);
  const s = summariseQuickBooks(d);
  assert.equal(s.accounts, 10, 'receivable and payable come with the parties, not as accounts');
  assert.equal(s.customers, 1);
  assert.equal(s.vendors, 1);
  assert.equal(s.items, 2);
  assert.equal(s.posting, 6);
  assert.equal(d.dateOrder, 'dmy');
  const { vouchers, masters } = toImportShapes(d);
  const bill = vouchers.find((v) => v.voucherType === 'Bill')!;
  assert.equal(bill.baseType, 'Purchase');
  assert.deepEqual(bill.lines.find((l) => l.ledger === 'Sundaram Auto Components'), { ledger: 'Sundaram Auto Components', debitPaise: 0, creditPaise: 7_080_00 });
  assert.equal(vouchers.find((v) => v.voucherType === 'Bill Payment')!.baseType, 'Payment');
  assert.equal(masters.stockItems.find((i) => i.name === 'Fitting Labour')!.kind, 'service');
});

test("QuickBooks Online's Journal report: title rows, continued lines, totals, and a number with # in it", () => {
  const rows = [
    ['Sri Balaji Traders'], ['Journal'], ['1 November - 30 November, 2026'], [],
    ['Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Account', 'Debit', 'Credit'],
    ['05/11/2026', 'Invoice', 'INV#1001', 'Velocity Motors', 'Brake pads', 'Accounts Receivable (A/R)', '₹5,900.00', ''],
    ['', '', '', 'Velocity Motors', 'Brake pads', 'Sales', '', '₹5,000.00'],
    ['', '', '', '', '', 'Output CGST', '', '₹450.00'],
    ['', '', '', '', '', 'Output SGST', '', '₹450.00'],
    ['', '', '', '', '', '', '₹5,900.00', '₹5,900.00'],
    ['25/11/2026', 'Expense', '', 'TNEB', 'Power', 'Electricity', '1,200.00', ''],
    ['25/11/2026', 'Expense', '', 'TNEB', 'Power', 'HDFC Bank', '', '1,200.00'],
    ['TOTAL', '', '', '', '', '', '₹7,100.00', '₹7,100.00'],
  ];
  const d = parseQuickBooks([{ name: 'Journal.csv', rows }]);
  assert.equal(d.transactions.length, 2);
  assert.equal(d.transactions[0].number, 'INV#1001');
  assert.equal(d.transactions[0].lines.length, 4, 'the totals row is not a line');
  const { vouchers } = toImportShapes(d);
  assert.deepEqual(vouchers[0].lines[0], { ledger: 'Velocity Motors', debitPaise: 5_900_00, creditPaise: 0 }, 'the receivable line goes to the customer');
  assert.equal(vouchers[1].baseType, 'Payment');
  assert.equal(d.dateOrder, 'dmy');
});

test("QuickBooks Online's lists: balances on their normal side become openings when no transactions come", () => {
  const files = [
    { name: 'Account List.csv', rows: [['Full name', 'Type', 'Detail type', 'Description', 'Balance'], ['HDFC Bank', 'Bank', 'Current', '', '1,50,000.00'], ['Term Loan', 'Long Term Liabilities', 'Notes Payable', '', '2,00,000.00'], ['Sales', 'Income', 'Sales of Product Income', '', '']] },
    { name: 'Customers.csv', rows: [['Customer', 'Company name', 'Email', 'Phone', 'GSTIN', 'Open balance'], ['Velocity Motors', 'Velocity Motors Pvt Ltd', 'ap@velocity.example', '9840000001', '33AABCV1234F1Z5', '25,000.00']] },
    { name: 'Products.csv', rows: [['Product/Service Name', 'Type', 'Sales Price/Rate', 'Purchase Cost', 'HSN/SAC', 'Qty On Hand'], ['Brake Pad Set', 'Inventory', '1,200', '800', '8708', '10'], ['Fitting', 'Service', '500', '', '998714', '']] },
  ];
  const { masters } = toImportShapes(parseQuickBooks(files));
  assert.equal(masters.ledgers.find((l) => l.name === 'HDFC Bank')!.balancePaise, 1_50_000_00);
  assert.equal(masters.ledgers.find((l) => l.name === 'Term Loan')!.balancePaise, -2_00_000_00, 'a liability is a credit');
  const cust = masters.ledgers.find((l) => l.name === 'Velocity Motors')!;
  assert.equal(cust.parent, 'Sundry Debtors');
  assert.equal(cust.balancePaise, 25_000_00);
  assert.equal(cust.gstin, '33AABCV1234F1Z5');
  const pad = masters.stockItems.find((i) => i.name === 'Brake Pad Set')!;
  assert.deepEqual([pad.qty, pad.valuePaise, pad.salePricePaise, pad.hsn], [10, 8_000_00, 1_200_00, '8708']);
});

interface Fixture { trx: Trx; orgId: number; branchId: number; acc: Record<string, number> }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'QuickBooks Move Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      await setBooksStartDate(trx, orgId, '2026-04-01');
      await fn({ trx, orgId, branchId, acc: await accountIds(trx, orgId) });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}
const ctx = (f: Fixture) => ({ orgId: f.orgId, userId: null, branchId: f.branchId, onDuplicate: 'skip' as const });

test('the sample company comes across: accounts, parties, items, every transaction once, GST each way', async () => {
  await withFixture(async (f) => {
    const { masters, vouchers } = toImportShapes(parseQuickBooks([{ name: 'sample.iif', rows: iifRows(quickBooksSampleIif(TODAY)) }]));
    const lists = await importTally(f.trx, ctx(f), masters, 'QuickBooks');
    assert.deepEqual(lists.flatMap((o) => o.errors), []);
    const from = { companyId: QUICKBOOKS_COMPANY_ID, source: 'QuickBooks' };
    const out = await importTallyFileVouchers(f.trx, ctx(f), vouchers, masters, from);
    assert.deepEqual(out.errors, []);
    assert.equal(out.created, 6);

    const net = async (accountId: number) => Number((await sql<{ v: string }>`
      SELECT COALESCE(SUM(l.debit - l.credit), 0) AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.org_id = ${f.orgId} AND l.account_id = ${accountId}`.execute(f.trx)).rows[0].v);
    assert.equal(await net(f.acc[CODE.ITC_CGST]), 540);
    assert.equal(await net(f.acc[CODE.GST_CGST]), -810);
    assert.equal(await net(f.acc[CODE.AR]), 0, 'invoiced and received');
    assert.equal(await net(f.acc[CODE.AP]), 0, 'billed and paid');
    const customer = await f.trx.selectFrom('contacts').select(['kind', 'email']).where('org_id', '=', f.orgId).where('display_name', '=', QB_SAMPLE_CUSTOMER).executeTakeFirstOrThrow();
    assert.deepEqual([customer.kind, customer.email], ['customer', 'accounts@kaverimotors.example']);
    const service = await f.trx.selectFrom('items').select(['kind', 'sale_price']).where('org_id', '=', f.orgId).where('name', '=', 'Fitting Labour').executeTakeFirstOrThrow();
    assert.equal(service.kind, 'service');
    assert.equal(Number(service.sale_price), 600);
    const memo = await f.trx.selectFrom('journal_entries').select('memo').where('org_id', '=', f.orgId).where('source_type', '=', 'tally_import').orderBy('id').executeTakeFirstOrThrow();
    assert.match(memo.memo ?? '', /^QuickBooks Bill SAC-778/);
    assert.ok((await verifyLedgerBalances(f.trx, f.orgId)).balanced);

    const again = await importTallyFileVouchers(f.trx, ctx(f), vouchers, masters, from);
    assert.equal(again.created, 0);
    assert.equal(again.skipped, 6);
  });
});

test.after(async () => {
  await db.destroy();
});
