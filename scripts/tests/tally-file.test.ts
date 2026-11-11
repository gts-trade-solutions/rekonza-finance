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
import { deflateRawSync } from 'node:zlib';
import { zipText } from '../../lib/xlsx';
import { isTallyDataFile, sortTallyPicks, unzipEntry, zipEntries } from '../../lib/tally/data-files';
import { outstandingBeyondDocuments } from '../../lib/server/services/party-outstanding';

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

test("masters again, or a later Tally export: the unpaid bills are found, not entered twice", async () => {
  await withFixture(async (f) => {
    const ledger = (name: string, parent: string, ref: string, amount: string) =>
      `<TALLYMESSAGE><LEDGER NAME="${name}" ACTION="Create"><PARENT>${parent}</PARENT><OPENINGBALANCE>${amount}</OPENINGBALANCE>` +
      `<BILLALLOCATIONS.LIST><BILLDATE>20260315</BILLDATE><NAME>${ref}</NAME><OPENINGBALANCE>${amount}</OPENINGBALANCE></BILLALLOCATIONS.LIST></LEDGER></TALLYMESSAGE>`;
    const xml = `<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>${
      ledger('Kaveri Motors', 'Sundry Debtors', 'OB/25-26/455', '-30000.00') + ledger('Lakshmi Auto Components', 'Sundry Creditors', 'LAC/25-26/990', '60000.00')
    }</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
    const file = parseTallyFiles([xml]);
    const bills = (o: Awaited<ReturnType<typeof importTally>>) => o.find((x) => x.kind === 'opening-bills')!;

    const first = await importTally(f.trx, ctx(f), file.masters);
    assert.deepEqual(first.flatMap((o) => o.errors), []);
    assert.equal(bills(first).created, 2);

    const again = await importTally(f.trx, ctx(f), file.masters);
    assert.deepEqual(again.flatMap((o) => o.errors), [], 'the same bill numbers again are not "already used"');
    assert.equal(bills(again).created, 0);
    assert.equal(bills(again).skipped, 2);
    const owed = await sql<{ ar: string; ap: string }>`
      SELECT COALESCE(SUM(CASE WHEN account_id = ${f.acc[CODE.AR]} THEN debit - credit END), 0) AS ar,
             COALESCE(SUM(CASE WHEN account_id = ${f.acc[CODE.AP]} THEN credit - debit END), 0) AS ap
        FROM journal_lines WHERE org_id = ${f.orgId}`.execute(f.trx);
    assert.equal(Number(owed.rows[0].ar), 30_000);
    assert.equal(Number(owed.rows[0].ap), 60_000);

    // Asked to stop at a copy rather than pass over it, it says which bill.
    const strict = await importTally(f.trx, { ...ctx(f), onDuplicate: 'error' }, file.masters);
    assert.match(bills(strict).errors.map((e) => e.message).join(' '), /OB\/25-26\/455 is already an opening bill for Kaveri Motors/);
  });
});

test("a Tally party's page owes what their statement says: opening bills and vouchers, not only invoices", async () => {
  await withFixture(async (f) => {
    const ledger = (name: string, parent: string, body = '') =>
      `<TALLYMESSAGE><LEDGER NAME="${name}" ACTION="Create"><PARENT>${parent}</PARENT>${body}</LEDGER></TALLYMESSAGE>`;
    const bill = (ref: string, amount: string) =>
      `<OPENINGBALANCE>${amount}</OPENINGBALANCE><BILLALLOCATIONS.LIST><BILLDATE>20260315</BILLDATE><NAME>${ref}</NAME><OPENINGBALANCE>${amount}</OPENINGBALANCE></BILLALLOCATIONS.LIST>`;
    // Tally writes a debit as a negative amount.
    const v = (guid: string, type: string, lines: [string, number][]) =>
      `<TALLYMESSAGE><VOUCHER VCHTYPE="${type}"><GUID>${guid}</GUID><DATE>20260601</DATE><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME><VOUCHERNUMBER>${guid}</VOUCHERNUMBER>` +
      lines.map(([l, r]) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${l}</LEDGERNAME><AMOUNT>${(-r).toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`).join('') +
      '</VOUCHER></TALLYMESSAGE>';
    const xml = `<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>${[
      ledger('Kaveri Motors', 'Sundry Debtors', bill('OB/25-26/455', '-30000.00')),
      ledger('Lakshmi Auto Components', 'Sundry Creditors', bill('LAC/25-26/990', '60000.00')),
      ledger('Sales - Spare Parts', 'Sales Accounts'),
      ledger('HDFC Current', 'Bank Accounts'),
      v('s1', 'Sales', [['Kaveri Motors', 11_800], ['Sales - Spare Parts', -11_800]]),
      v('r1', 'Receipt', [['HDFC Current', 5_000], ['Kaveri Motors', -5_000]]),
      v('p1', 'Payment', [['Lakshmi Auto Components', 20_000], ['HDFC Current', -20_000]]),
    ].join('')}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
    const file = parseTallyFiles([xml]);
    assert.deepEqual((await importTally(f.trx, ctx(f), file.masters)).flatMap((o) => o.errors), []);
    const out = await importTallyFileVouchers(f.trx, ctx(f), file.vouchers, file.masters);
    assert.deepEqual(out.errors, []);
    assert.equal(out.created, 3);

    const idOf = async (name: string) => (await f.trx.selectFrom('contacts').select('id').where('org_id', '=', f.orgId).where('display_name', '=', name).executeTakeFirstOrThrow()).id;
    const kaveri = await idOf('Kaveri Motors');
    const lakshmi = await idOf('Lakshmi Auto Components');
    const beyond = await outstandingBeyondDocuments(f.trx, f.orgId, [kaveri, lakshmi]);
    // No invoice or bill here, yet Kaveri owes 30,000 + 11,800 − 5,000 and we owe Lakshmi 60,000 − 20,000.
    assert.deepEqual(beyond.get(kaveri), { receivablePaise: 36_800_00, payablePaise: 0 });
    assert.deepEqual(beyond.get(lakshmi), { receivablePaise: 0, payablePaise: 40_000_00 });

    // The same figure the statement reads from the ledger.
    const ledgerSays = await sql<{ ar: string; ap: string }>`
      SELECT COALESCE(SUM(CASE WHEN account_id = ${f.acc[CODE.AR]} AND contact_id = ${kaveri} THEN debit - credit END), 0) AS ar,
             COALESCE(SUM(CASE WHEN account_id = ${f.acc[CODE.AP]} AND contact_id = ${lakshmi} THEN credit - debit END), 0) AS ap
        FROM journal_lines WHERE org_id = ${f.orgId}`.execute(f.trx);
    assert.equal(Number(ledgerSays.rows[0].ar), 36_800);
    assert.equal(Number(ledgerSays.rows[0].ap), 40_000);
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

/** One deflated file in a zip, the way Windows' "Send to → Compressed folder" packs it. */
function deflatedZip(name: string, text: string): Uint8Array {
  const raw = Buffer.from(text, 'utf8');
  const data = deflateRawSync(raw);
  const n = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + n.length, 12); end.writeUInt32LE(30 + n.length + data.length, 16);
  return new Uint8Array(Buffer.concat([local, n, data, cd, n, end]));
}

test("Tally's own data folder is told apart from the files Tally exports", () => {
  for (const n of ['Company.900', 'TranMgr.900', 'TSTATE.TSF', 'TAccess.tsf', 'Company.1800', 'TBK900.001', '100000/LinkMgr.900', 'C:\\data\\100000\\SumTran.900']) {
    assert.ok(isTallyDataFile(n), n);
  }
  for (const n of ['DayBook.xml', 'Master.xml', 'report.900.xml', 'books.zip', 'TBK.001x']) assert.ok(!isTallyDataFile(n), n);
  assert.deepEqual(sortTallyPicks(['Company.900', 'DayBook.xml', 'data.zip', 'notes.pdf']), {
    exports: ['DayBook.xml'], dataFiles: ['Company.900'], zips: ['data.zip'], other: ['notes.pdf'],
  });
});

test('a zip: its files listed, and the Tally XML inside opened, stored or deflated', async () => {
  const xml = tallySampleXml('2026-11-10');
  const stored = new Blob([zipText([['100000/Company.900', 'not text'], ['exports/DayBook.xml', xml]]) as BlobPart]);
  const entries = await zipEntries(stored);
  assert.deepEqual(entries.map((e) => e.name), ['100000/Company.900', 'exports/DayBook.xml']);
  assert.equal(new TextDecoder().decode(await unzipEntry(stored, entries[1])), xml);

  const deflated = new Blob([deflatedZip('Master.xml', xml) as BlobPart]);
  const [entry] = await zipEntries(deflated);
  assert.equal(entry.method, 8);
  const text = await readTallyFile(new Blob([(await unzipEntry(deflated, entry)) as BlobPart]));
  assert.equal(text, xml);
  assert.ok(summariseTallyFile(parseTallyFiles([text])).ledgers > 0);

  await assert.rejects(zipEntries(new Blob(['not a zip at all'])), /not a zip/);
});

test.after(async () => {
  await db.destroy();
});
