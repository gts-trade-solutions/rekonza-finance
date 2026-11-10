// Tally's own XML files — masters and the Day Book's vouchers — read and
// brought into the books, the way Tally → Import does it.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/tally-file.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { setBooksStartDate } from '../../lib/server/services/opening-balances';
import { importTally, importTallyFileVouchers } from '../../lib/server/imports/tally';
import { debitPaise, parseTallyFiles, readTallyFile, summariseTallyFile } from '../../lib/tally/xml';
import { tallySampleXml } from '../../lib/tally/sample';

interface Fixture { trx: Trx; orgId: number; branchId: number; acc: Record<string, number> }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Tally File Co' }).executeTakeFirstOrThrow()).insertId);
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
const TODAY = '2026-11-07';

/** Net debit on an account, in rupees, from the Tally vouchers only. */
async function net(f: Fixture, accountId: number) {
  const { rows } = await sql<{ v: string }>`
    SELECT COALESCE(SUM(l.debit - l.credit), 0) AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.org_id = ${f.orgId} AND l.account_id = ${accountId} AND e.source_type = 'tally_import'`.execute(f.trx);
  return Number(rows[0].v);
}

test('reads a Tally file: masters, vouchers, and what it leaves out', () => {
  const file = parseTallyFiles([tallySampleXml(TODAY)]);
  const s = summariseTallyFile(file);
  assert.equal(s.company, 'Sri Balaji Auto Parts (sample)');
  assert.equal(s.ledgers, 11);
  assert.equal(s.parties, 2, 'a debtor under a group of its own still counts');
  assert.equal(s.stockItems, 2);
  assert.equal(s.vouchers, 9);
  assert.equal(s.posting, 7);
  assert.equal(s.cancelled, 1);
  assert.equal(s.nonAccounting, 1, 'the sales order posts nothing');
  const sale = file.vouchers.find((v) => v.number === 'SB/0042')!;
  assert.equal(sale.baseType, 'Sales', '"GST Sales" is a kind of Sales, from the voucher type master');
  // The sales ledger sits inside the stock line in an invoice-mode voucher.
  assert.deepEqual(sale.lines.find((l) => l.ledger === 'Sales @ 18%'), { ledger: 'Sales @ 18%', debitPaise: 0, creditPaise: 10_000_00 });
  assert.deepEqual(sale.lines.find((l) => l.ledger === 'Sri Murugan Auto Stores'), { ledger: 'Sri Murugan Auto Stores', debitPaise: 11_800_00, creditPaise: 0 });
  assert.equal(file.masters.stockItems[0].gstRatePct, 18);
});

test("Tally's amounts: a debit is negative, or written with Dr", () => {
  assert.equal(debitPaise('-1180.00'), 118000);
  assert.equal(debitPaise('1180.00'), -118000);
  assert.equal(debitPaise('1,180.00 Dr'), 118000);
  assert.equal(debitPaise('1,180.00 Cr'), -118000);
  assert.equal(debitPaise(null), 0);
});

test('a UTF-16 file, as Tally writes it, reads the same as UTF-8', async () => {
  const xml = tallySampleXml(TODAY);
  const utf16 = new Uint8Array(2 + xml.length * 2);
  utf16[0] = 0xff; utf16[1] = 0xfe;
  for (let i = 0; i < xml.length; i++) { const c = xml.charCodeAt(i); utf16[2 + i * 2] = c & 0xff; utf16[3 + i * 2] = c >> 8; }
  assert.equal(await readTallyFile(new Blob([utf16])), xml);
});

test('masters and vouchers in one upload: the company comes across, every voucher once', async () => {
  await withFixture(async (f) => {
    const file = parseTallyFiles([tallySampleXml(TODAY)]);
    const masters = await importTally(f.trx, ctx(f), file.masters);
    assert.deepEqual(masters.flatMap((o) => o.errors), []);
    const out = await importTallyFileVouchers(f.trx, ctx(f), file.vouchers, file.masters);
    assert.deepEqual(out.errors, []);
    assert.equal(out.created, 7);
    assert.match(out.notes.join(' '), /2 voucher\(s\) in the file post nothing/);

    const customer = await f.trx.selectFrom('contacts').select(['id', 'kind']).where('org_id', '=', f.orgId).where('display_name', '=', 'Sri Murugan Auto Stores').executeTakeFirstOrThrow();
    assert.equal(customer.kind, 'customer');
    // Billed 11,800 and received 11,800: nothing owed.
    const owed = await sql<{ v: string }>`SELECT COALESCE(SUM(debit - credit), 0) AS v FROM journal_lines WHERE org_id = ${f.orgId} AND account_id = ${f.acc[CODE.AR]} AND contact_id = ${customer.id}`.execute(f.trx);
    assert.equal(Number(owed.rows[0].v), 0);
    // One "CGST" ledger in Tally: input on the purchase, output on the sale.
    assert.equal(await net(f, f.acc[CODE.ITC_CGST]), 450);
    assert.equal(await net(f, f.acc[CODE.GST_CGST]), -900);
    assert.equal(await net(f, f.acc[CODE.AP]), 0, 'the vendor billed and paid');
    const bank = await f.trx.selectFrom('bank_accounts').select('ledger_account_id').where('org_id', '=', f.orgId).where('name', '=', 'Canara Bank - Current A/c').executeTakeFirstOrThrow();
    assert.equal(await net(f, bank.ledger_account_id), 11_800 - 5_000 - 5_900);
    assert.ok((await verifyLedgerBalances(f.trx, f.orgId)).balanced);

    // The same file again: nothing doubles.
    const again = await importTallyFileVouchers(f.trx, ctx(f), file.vouchers, file.masters);
    assert.equal(again.created, 0);
    assert.equal(again.skipped, 7);
  });
});

test('vouchers alone, against masters already here: each ledger found by its name', async () => {
  await withFixture(async (f) => {
    await f.trx.insertInto('contacts').values([
      { org_id: f.orgId, kind: 'customer', display_name: 'Sharma Traders', state_code: '33', gst_treatment: 'unregistered' },
      { org_id: f.orgId, kind: 'vendor', display_name: 'Bosch Ltd', state_code: '33', gst_treatment: 'unregistered' },
    ] as never).execute();
    await f.trx.insertInto('bank_accounts').values({ org_id: f.orgId, kind: 'bank', name: 'HDFC Current', ledger_account_id: f.acc[CODE.BANK_DEFAULT], opening_balance: '0.0000' }).execute();
    await f.trx.insertInto('accounts').values({ org_id: f.orgId, code: '4800', name: 'Sales', type: 'income' }).execute();
    const day = (iso: string) => iso.replace(/-/g, '');
    const v = (guid: string, type: string, date: string, lines: [string, number][]) =>
      `<VOUCHER VCHTYPE="${type}"><GUID>${guid}</GUID><DATE>${day(date)}</DATE><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME><VOUCHERNUMBER>${guid}</VOUCHERNUMBER>` +
      lines.map(([l, r]) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${l}</LEDGERNAME><AMOUNT>${(-r).toFixed(2)}</AMOUNT>` +
        // A bill allocation carries an amount of its own; the entry's is the one that counts.
        `<BILLALLOCATIONS.LIST><NAME>B1</NAME><AMOUNT>${(-r * 7).toFixed(2)}</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST>`).join('') +
      '</VOUCHER>';
    const xml = `<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>${[
      v('s1', 'Sales', '2026-06-01', [['Sharma Traders', 1180], ['Sales', -1000], ['Output CGST', -90], ['Output SGST', -90]]),
      v('p1', 'Payment', '2026-06-03', [['Bosch Ltd', 10_000], ['TDS on Contracts 194C', -100], ['HDFC Current', -9_900]]),
      v('r0', 'Receipt', '2026-03-20', [['HDFC Current', 500], ['Sharma Traders', -500]]),
      v('j1', 'Journal', '2026-06-05', [['Staff Welfare', 300], ['HDFC Current', -300]]),
    ].join('')}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
    const file = parseTallyFiles([xml]);
    assert.equal(file.vouchers.find((x) => x.guid === 'p1')?.lines.find((l) => l.ledger === 'Bosch Ltd')?.debitPaise, 10_000_00);

    const out = await importTallyFileVouchers(f.trx, ctx(f), file.vouchers);
    assert.equal(out.created, 2);
    assert.equal(out.errors.length, 1);
    assert.match(out.errors[0].message, /no account for Staff Welfare/);
    assert.match(out.notes.join(' '), /1 voucher\(s\) are dated before the books start/);
    assert.equal(await net(f, f.acc[CODE.GST_CGST]), -90);
    assert.equal(await net(f, f.acc[CODE.TDS_PAYABLE]), -100, 'TDS deducted on a payment is owed to the government');
    assert.equal(await net(f, f.acc[CODE.AP]), 10_000);
    assert.ok((await verifyLedgerBalances(f.trx, f.orgId)).balanced);
  });
});

test.after(async () => {
  await db.destroy();
});
